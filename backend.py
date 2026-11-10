import sys
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

import asyncio
import json
import os
import re
import threading
import time
import webbrowser
from typing import List, Optional

import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])

# Настройки LLM
LLM_BACKEND = os.getenv("LLM_BACKEND", "ollama")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:3b")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434/api/chat")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.cerebras.ai/v1")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "")

# Оптимизация: 2048 токенов достаточно, 4096 сильно замедляло генерацию
NUM_CTX = int(os.getenv("NUM_CTX", "2048"))      
LLM_PARALLEL = int(os.getenv("LLM_PARALLEL", "1"))  

class Option(BaseModel):
    id: str
    label: str = ""
    note: str = ""

class Carry(BaseModel):
    id: str
    size: str = "1x1"
    in_order: bool = False
    order_zone: Optional[int] = None

class ThinkRequest(BaseModel):
    name: str
    x: int
    y: int
    battery: float
    charging: bool = False
    place: str = "проход"
    carrying: Optional[Carry] = None
    reason: str = "idle"
    stuck_reason: Optional[str] = None
    radar: Optional[str] = None
    free_sides: Optional[str] = None
    orders: List[dict] = Field(default_factory=list)
    inbound: dict = Field(default_factory=dict)
    team_score: float = 0
    penalty_inbound: bool = False
    penalty_order: bool = False
    options: List[Option] = Field(default_factory=list)
    unavailable: List[str] = Field(default_factory=list)
    recent_chat: List[str] = Field(default_factory=list)
    last_action: str = ""
    last_result: str = ""

SYSTEM_PROMPT = """Ты - мозг складского робота. Получаешь ФАКТЫ и список ДОСТУПНО. Выбери ровно ОДИН id из списка.

ПРИОРИТЕТЫ:
1. БАТАРЕЯ < 20% и не на зарядке -> CHARGER_*.
2. На зарядке и БАТАРЕЯ < 90% -> WAIT.
3. ШТРАФ очереди > 7 и РУКИ ПУСТО -> INBOUND.
4. Несёшь МУСОР (нет в заказах) -> DROP (если безопасно, у стены) или SWAP.
5. Несёшь НУЖНУЮ -> OUTBOUND_* с пометкой "ЗОНА ЗАКАЗА #ID".
6. РУКИ ПУСТО и есть заказы: GO_PICK_* (далеко), PICK_* (рядом), иначе INBOUND.
7. РУКИ ПУСТО и НЕТ заказов -> WAIT (или CHARGER, если < 30%).
8. ЗАСТРЯЛ: есть STEP_* -> туда. Если окружён -> PUSH_* в сторону свободного места. SAY_HELP - крайний случай.

ОБЩЕНИЕ: В поле "say" коротко (до 30 символов).
Если РУКИ: ПУСТО - нельзя писать "взял/везу" и номера коробок.

Ответ - только JSON: {"action":"ID","say":"..."}"""

REASONS = {
    "start": "начало смены", "idle": "стоишь без дела", "arrived": "приехал",
    "picked": "получил коробку", "delivered": "сдал в заказ",
    "dropped": "сбросил коробку", "refused": "команда не сработала",
    "stuck": "застрял", "pushed": "сдвинул коробку", "battery_low": "батарея села",
    "inbound_overflow": "перегрузка приёмки", "stale": "ситуация изменилась",
}

def render_context(p: ThinkRequest) -> str:
    L = [f"ПОВОД: {REASONS.get(p.reason, p.reason)}", f"ТЫ: {p.name}, ({p.x},{p.y}), место: {p.place}"]
    bat = f"БАТАРЕЯ: {p.battery:.0f}%"
    if p.charging: bat += " (заряжается)"
    L.append(bat)

    if p.carrying:
        c = p.carrying
        if c.in_order:
            L.append(f"РУКИ: {c.id} ({c.size}). НУЖНАЯ (зона #{c.order_zone})")
        else:
            L.append(f"РУКИ: {c.id} ({c.size}). МУСОР")
    else:
        L.append("РУКИ: ПУСТО")

    q = p.inbound.get("queue", 0)
    alerts = []
    if p.battery < 20: alerts.append("БАТАРЕЯ < 20%")
    if p.penalty_inbound: alerts.append(f"ШТРАФ очереди ({q})")
    if p.penalty_order: alerts.append("ШТРАФ заказа")
    if p.stuck_reason: alerts.append(f"ЗАСТРЯЛ: {p.stuck_reason}")
    L.append("ТРЕВОГИ: " + ("; ".join(alerts) if alerts else "нет"))

    if p.orders:
        L.append("ЗАКАЗЫ:")
        for o in p.orders:
            L.append(f"  #{o.get('id')}: нужны {', '.join(o.get('required', []))} (собрано {len(o.get('collected', []))}); зона #{o.get('zone')}; осталось тиков: {o.get('ticks_left')}")
    else:
        L.append("ЗАКАЗОВ НЕТ")

    head = p.inbound.get("head")
    L.append(f"ПРИЁМКА: очередь {q}" + (f"; след. {head}" if head else ""))

    if p.free_sides is not None and (p.stuck_reason or p.radar):
        L.append("СВОБОДНЫЕ СТОРОНЫ: " + (p.free_sides or "НЕТ (окружён)"))
    if p.radar:
        L.append("РАДАР:\n" + p.radar.rstrip())

    L.append("ДОСТУПНО:")
    for opt in p.options:
        L.append(f"  - {opt.id}: {opt.label}" + (f" - {opt.note}" if opt.note else ""))
    if p.unavailable:
        L.append("НЕДОСТУПНО: " + "; ".join(p.unavailable))

    L.append("Верни JSON.")
    return "\n".join(L)

def _o(i, label, note=""):
    return Option(id=i, label=label, note=note)

def _example(req: ThinkRequest, action: str, say: str):
    return [{"role": "user", "content": render_context(req)},
            {"role": "assistant", "content": json.dumps({"action": action, "say": say}, ensure_ascii=False)}]

_ORD1 = {"id": 101, "required": ["#1001", "#1002"], "collected": [], "zone": 2, "ticks_left": 40}
_INB = {"queue": 3, "head": "#1001"}

def build_fewshot() -> list:
    msgs = []
    # 1. Идем в приемку
    msgs += _example(ThinkRequest(name="А", x=12, y=9, battery=76, orders=[_ORD1], inbound=_INB, reason="idle",
        options=[_o("INBOUND", "Приёмка", "10 шагов"), _o("WAIT", "Ждать")]), "INBOUND", "Еду в приёмку")
    
    # 2. Везем коробку в отгрузку
    msgs += _example(ThinkRequest(name="Б", x=3, y=7, battery=64, place="приёмка", reason="picked", orders=[_ORD1], inbound=_INB,
        carrying=Carry(id="#1001", in_order=True, order_zone=2),
        options=[_o("OUTBOUND_2", "Отгрузка #2", "20 шагов"), _o("WAIT", "Ждать")]), 
        "OUTBOUND_2", "Везу в отгрузку")
    
    # 3. Сброс мусора у стены
    msgs += _example(ThinkRequest(name="В", x=10, y=2, battery=58, reason="idle", orders=[_ORD1], inbound=_INB,
        carrying=Carry(id="#1003", in_order=False), 
        options=[_o("DROP", "Сбросить", "безопасно"), _o("WAIT", "Ждать")]), 
        "DROP", "Сбрасываю мусор")
        
    # 4. Толкаем коробку
    radar = ".......\n.......\n..BBB..\n.BBAB..\n..BBB..\n.......\n......."
    msgs += _example(ThinkRequest(name="Б", x=14, y=5, battery=61, reason="stuck", orders=[_ORD1], inbound=_INB,
        stuck_reason="окружён", radar=radar, free_sides="",
        options=[_o("PUSH_N", "Толкнуть вверх"), _o("SAY_HELP", "Крикнуть"), _o("WAIT", "Ждать")]),
        "PUSH_N", "Расчищаю выход")

    return msgs

FEWSHOT = build_fewshot()

ID_RE = re.compile(r"#\d+")
HAND_WORDS = re.compile(r"(взял|везу|несу|сдал|сбросил|мусор)", re.I)
EMPTY_CLAIMS = re.compile(r"(жду коробку|руки пусты)", re.I)

def check_say(p: ThinkRequest, action: str, say: str) -> Optional[str]:
    if not say: return None
    s = say.lower()
    if not p.carrying:
        if HAND_WORDS.search(s) or ID_RE.search(say):
            return "Руки пусты, нельзя говорить про коробку."
    else:
        foreign = set(ID_RE.findall(say)) - {p.carrying.id}
        if foreign: return f"В руках только {p.carrying.id}, а в say другой номер."
        if EMPTY_CLAIMS.search(s): return f"Руки НЕ пусты."
        if "мусор" in s and p.carrying.in_order: return f"{p.carrying.id} - нужная."
    return None

def call_ollama(messages: list, schema: dict) -> str:
    r = requests.post(OLLAMA_URL, json={
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "format": schema,
        "keep_alive": "30m",
        "options": {
            "temperature": 0, 
            "num_ctx": NUM_CTX,
            "num_predict": 40
        }, 
    }, timeout=60) # Снизил таймаут до 60с для отзывчивости
    r.raise_for_status()
    return r.json()["message"]["content"]

def call_llm(messages: list, option_ids: List[str]) -> str:
    schema = {"type": "object", "properties": {"action": {"type": "string", "enum": option_ids}, "say": {"type": "string", "maxLength": 40}}, "required": ["action", "say"]}
    return call_ollama(messages, schema)

_sem: Optional[asyncio.Semaphore] = None

@app.post("/api/think")
async def think(p: ThinkRequest):
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(max(1, LLM_PARALLEL))

    # Фильтрация опций (Safety-net)
    if p.carrying and not p.carrying.in_order:
        new_options = [o for o in p.options if not o.id.startswith("OUTBOUND")]
        removed = [o.id for o in p.options if o.id.startswith("OUTBOUND")]
        p.unavailable.extend([f"{oid} (нельзя с мусором)" for oid in removed])
        p.options = new_options

    if p.battery > 30 and not p.charging:
        new_options = [o for o in p.options if not o.id.startswith("CHARGER")]
        removed = [o.id for o in p.options if o.id.startswith("CHARGER")]
        p.unavailable.extend([f"{oid} (батарея в норме)" for oid in removed])
        p.options = new_options

    option_ids = [o.id for o in p.options]
    if "WAIT" not in option_ids: option_ids.append("WAIT")
    
    if len(option_ids) == 1:
        return {"action": "WAIT", "say": "Жду."}

    context = render_context(p)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *FEWSHOT, {"role": "user", "content": context}]

    decision = None
    t0 = time.perf_counter()
    async with _sem:
        try:
            raw = await asyncio.to_thread(call_llm, messages, option_ids)
            parsed = json.loads(raw)
            action = parsed.get("action", "WAIT")
            if action not in option_ids: action = "WAIT"
            say = parsed.get("say", "").strip()
            
            err = check_say(p, action, say)
            if err: say = ""
                
            decision = {"action": action, "say": say}
        except Exception as e:
            print(f"[{p.name}] ОШИБКА: {e}")
            decision = {"action": "WAIT", "say": ""}

    print(f"[{p.name}] -> {decision['action']:<12} [{decision['say']}]  {time.perf_counter() - t0:.1f}s")
    return decision

def open_browser():
    time.sleep(1.5)
    webbrowser.open(f"file:///{os.path.abspath('index.html')}")

if __name__ == "__main__":
    import uvicorn
    threading.Thread(target=open_browser, daemon=True).start()
    uvicorn.run(app, host="0.0.0.0", port=8000)