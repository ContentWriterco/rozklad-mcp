#!/usr/bin/env python3
"""
Generates the animated README demo (docs/demo-pl.svg, docs/demo-en.svg): a user types a question,
the agent calls plan_journey and answers. Content = a real answer of the public server
(Zbąszyń -> Kórnik, 2026-10-22). Pure SVG + SMIL, adapts to light/dark mode.
Usage: python3 scripts/make-demo-svg.py
"""
import os
from xml.sax.saxutils import escape

W, FS, CW = 860, 14, 8.45  # width, font size, monospace char width (approx.)
LOOP = 18.0  # seconds
X0 = 28

TEXT = {
    "pl": {
        "title": "Claude · rozklad-mcp",
        "you": "Ty",
        "agent": "Agent",
        "q": "Jak dostanę się jutro rano ze Zbąszynia do Kórnika?",
        "tool": 'plan_journey(from: "Zbąszyń", to: "Kórnik", date: "jutro")',
        "done": "3 połączenia · 0,4 s",
        "intro": "Najwygodniej z jedną przesiadką w Poznaniu:",
        "legs": [
            ("IC", "train", "08:22 Zbąszyń → 09:02 Poznań Gł.  IC 7204 „Zielonogórzanin”, peron 3"),
            ("pieszo", "walk", "4 min na dworzec autobusowy, stanowisko 9"),
            ("PKS", "bus", "09:15 → 09:46 Kórnik, Poznańska  linia 212 (PKS Poznań)"),
        ],
        "price": "Bilet IC z cennika: maks. 26–27 zł (2. klasa), w sprzedaży często taniej.",
        "alt": "Najwcześniej: 07:30 KW → Zbąszynek → EIC → Poznań → PKM4, Kórnik 09:09 (2 przesiadki).",
        "aria": "Animacja: użytkownik pyta agenta AI o połączenie ze Zbąszynia do Kórnika, agent wywołuje plan_journey z rozklad-mcp i podaje pociąg IC, przejście na dworzec autobusowy i autobus PKS z godzinami i ceną.",
    },
    "en": {
        "title": "Claude · rozklad-mcp",
        "you": "You",
        "agent": "Agent",
        "q": "How do I get from Zbąszyń to Kórnik tomorrow morning?",
        "tool": 'plan_journey(from: "Zbąszyń", to: "Kórnik", date: "tomorrow")',
        "done": "3 connections · 0.4 s",
        "intro": "Easiest, with one change in Poznań:",
        "legs": [
            ("IC", "train", "08:22 Zbąszyń → 09:02 Poznań Gł.  IC 7204 Zielonogórzanin, platform 3"),
            ("walk", "walk", "4 min to the bus station, stand 9"),
            ("bus", "bus", "09:15 → 09:46 Kórnik, Poznańska  line 212 (PKS Poznań)"),
        ],
        "price": "IC price list: max 26–27 zł (2nd class), often cheaper in sale.",
        "alt": "Earliest: 07:30 KW → Zbąszynek → EIC → Poznań → PKM4, Kórnik 09:09 (2 changes).",
        "aria": "Animation: a user asks an AI agent how to get from Zbąszyń to Kórnik; the agent calls plan_journey from rozklad-mcp and answers with an IC train, a short walk and a PKS bus, with times and price.",
    },
}

T_TYPE0, T_TYPE1 = 0.6, 3.4          # typing the question
T_TOOL, T_TOOLDONE = 3.9, 5.3        # tool call chip, then "done"
T_ANS0, T_STEP = 5.8, 0.55           # answer lines
T_FADE = 16.8                        # everything fades out, loop restarts


def kt(t):
    return f"{t / LOOP:.4f}"


def appear(t, fade=0.25):
    """opacity: 0 until t, 1 until T_FADE, then 0"""
    return (f'<animate attributeName="opacity" dur="{LOOP}s" repeatCount="indefinite" '
            f'values="0;0;1;1;0;0" keyTimes="0;{kt(t)};{kt(t + fade)};{kt(T_FADE)};{kt(T_FADE + 0.5)};1"/>')


def typing(clip_id, text_len, x):
    n = text_len
    widths, times = [0], [0.0]
    for i in range(n + 1):
        t = T_TYPE0 + (T_TYPE1 - T_TYPE0) * i / n
        widths.append(round(i * CW + 2, 1))
        times.append(t / LOOP)
    widths += [n * CW + 2, 0]
    times += [(T_FADE + 0.5) / LOOP, 1.0]
    # keep strictly increasing key times
    vals = ";".join(str(w) for w in widths)
    keys = ";".join(f"{t:.4f}" for t in times)
    return (f'<clipPath id="{clip_id}"><rect x="{x}" y="0" height="2000" width="0">'
            f'<animate attributeName="width" dur="{LOOP}s" repeatCount="indefinite" calcMode="discrete" values="{vals}" keyTimes="{keys}"/>'
            f'</rect></clipPath>')


def svg(lang):
    t = TEXT[lang]
    out = []
    y = 0
    H_HEADER = 44
    y = H_HEADER + 34
    body = []
    defs = []

    # user message
    body.append(f'<text class="label" x="{X0}" y="{y}">{escape(t["you"])}</text>')
    y += 24
    bw = len(t["q"]) * CW + 30
    body.append(f'<rect class="bubble" x="{X0 - 10}" y="{y - 19}" width="{bw}" height="30" rx="8"/>')
    defs.append(typing("type", len(t["q"]), X0 + 4))
    body.append(f'<g clip-path="url(#type)"><text class="q" x="{X0 + 4}" y="{y}">{escape(t["q"])}</text></g>')
    # blinking cursor follows typing roughly: simple blink at end
    y += 46

    # tool call chip
    body.append(f'<g opacity="0">{appear(T_TOOL)}'
                f'<rect class="tool" x="{X0 - 10}" y="{y - 19}" width="{len(t["tool"]) * CW + 64}" height="30" rx="15"/>'
                f'<text class="toolic" x="{X0 + 4}" y="{y}">⚙</text>'
                f'<text class="toolt" x="{X0 + 26}" y="{y}">{escape(t["tool"])}</text></g>')
    # spinner dots -> done
    dx = X0 + len(t["tool"]) * CW + 72
    body.append(f'<g opacity="0"><animate attributeName="opacity" dur="{LOOP}s" repeatCount="indefinite" '
                f'values="0;0;1;1;0;0" keyTimes="0;{kt(T_TOOL)};{kt(T_TOOL + 0.1)};{kt(T_TOOLDONE)};{kt(T_TOOLDONE + 0.05)};1"/>'
                + "".join(
                    f'<circle class="dot" cx="{dx + i * 10}" cy="{y - 4}" r="3"><animate attributeName="opacity" values="0.2;1;0.2" dur="0.9s" begin="{i * 0.15}s" repeatCount="indefinite"/></circle>'
                    for i in range(3))
                + "</g>")
    body.append(f'<g opacity="0">{appear(T_TOOLDONE)}<text class="ok" x="{dx - 4}" y="{y}">✓ {escape(t["done"])}</text></g>')
    y += 50

    # answer
    ta = T_ANS0
    body.append(f'<g opacity="0">{appear(ta)}<text class="label" x="{X0}" y="{y}">{escape(t["agent"])}</text></g>')
    y += 26
    body.append(f'<g opacity="0">{appear(ta)}<text class="a" x="{X0}" y="{y}">{escape(t["intro"])}</text></g>')
    y += 12
    for i, (tag, kind, line) in enumerate(t["legs"]):
        ta += T_STEP
        y += 34
        pw = len(tag) * CW + 18
        body.append(
            f'<g opacity="0">{appear(ta)}'
            f'<line class="rail" x1="{X0 + 34}" y1="{y - 30}" x2="{X0 + 34}" y2="{y - 20}" />'
            f'<rect class="pill {kind}" x="{X0 + 34 - pw / 2}" y="{y - 17}" width="{pw}" height="22" rx="11"/>'
            f'<text class="pillt" x="{X0 + 34}" y="{y - 1}" text-anchor="middle">{escape(tag)}</text>'
            f'<text class="leg" x="{X0 + 82}" y="{y}">{escape(line)}</text></g>')
    ta += T_STEP
    y += 40
    body.append(f'<g opacity="0">{appear(ta)}<text class="price" x="{X0}" y="{y}">{escape(t["price"])}</text></g>')
    ta += T_STEP
    y += 26
    body.append(f'<g opacity="0">{appear(ta)}<text class="muted" x="{X0}" y="{y}">{escape(t["alt"])}</text></g>')
    H = y + 34

    style = """
  .bg{fill:#ffffff;stroke:#d0d7de}
  .hdr{fill:#f6f8fa}
  .hdrt{fill:#57606a;font:600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
  text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace;font-size:14px}
  .label{fill:#6e7781;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
  .bubble{fill:#ddf4ff;stroke:#b6e3ff}
  .q{fill:#0b2a4a}
  .tool{fill:#f6f8fa;stroke:#d0d7de}
  .toolic{fill:#8250df}
  .toolt{fill:#24292f;font-size:13px}
  .dot{fill:#8250df}
  .ok{fill:#1a7f37;font-size:13px}
  .a{fill:#24292f}
  .leg{fill:#24292f}
  .rail{stroke:#d0d7de;stroke-width:2}
  .pill.train{fill:#0969da}.pill.bus{fill:#bc4c00}.pill.walk{fill:#6e7781}
  .pillt{fill:#ffffff;font-size:12px;font-weight:700}
  .price{fill:#1a7f37}
  .muted{fill:#57606a;font-size:13px}
  @media (prefers-color-scheme: dark){
    .bg{fill:#0d1117;stroke:#30363d}.hdr{fill:#161b22}.hdrt{fill:#8b949e}
    .label{fill:#8b949e}.bubble{fill:#0c2d4a;stroke:#1f6feb}.q{fill:#cae8ff}
    .tool{fill:#161b22;stroke:#30363d}.toolt{fill:#c9d1d9}.toolic,.dot{fill:#bc8cff}
    .ok,.price{fill:#3fb950}.a,.leg{fill:#e6edf3}.rail{stroke:#30363d}
    .pill.train{fill:#1f6feb}.pill.bus{fill:#db6d28}.pill.walk{fill:#6e7681}.muted{fill:#8b949e}
  }"""
    head = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="{escape(t["aria"])}">'
            f'<title>{escape(t["aria"])}</title><style>{style}</style><defs>{"".join(defs)}</defs>'
            f'<rect class="bg" x="0.5" y="0.5" width="{W - 1}" height="{H - 1}" rx="12"/>'
            f'<path class="hdr" d="M12.5 0.5 H{W - 12.5} A12 12 0 0 1 {W - 0.5} 12.5 V{H_HEADER} H0.5 V12.5 A12 12 0 0 1 12.5 0.5 Z"/>'
            + "".join(f'<circle cx="{22 + i * 18}" cy="22" r="6" fill="{c}"/>' for i, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]))
            + f'<text class="hdrt" x="{W / 2}" y="27" text-anchor="middle">{escape(t["title"])}</text>')
    return head + "".join(body) + "</svg>\n"


here = os.path.join(os.path.dirname(__file__), "..", "docs")
for lang in TEXT:
    p = os.path.join(here, f"demo-{lang}.svg")
    with open(p, "w", encoding="utf-8") as f:
        f.write(svg(lang))
    print("wrote", os.path.normpath(p))
