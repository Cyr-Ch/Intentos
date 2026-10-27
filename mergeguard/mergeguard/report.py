"""Portable Markdown and self-contained HTML reports; all source text is escaped."""
from __future__ import annotations

from html import escape
from pathlib import Path

from . import breaker, ledger, prs


def data(repo=".") -> dict:
    registry = prs.read(repo)
    return {"prs": sorted(registry["prs"].values(), key=lambda p: p["number"]),
            "incidents": [e for e in ledger.read(repo) if e["type"] in {"culprit", "clash", "reverted"}],
            "breaker": breaker.status(repo), "generated_at": ledger.now()}


def markdown(report: dict) -> str:
    def cell(value):
        return escape(str(value)).replace("|", "\\|").replace("\n", "<br>")
    lines = ["# mergeguard · PR report", "", f"Generated {report['generated_at']}. Decisions below are saved snapshots; merge recomputes every check.", "",
             "| PR | State | Tier | Gate | Reasons | Evidence |", "| --- | --- | --- | --- | --- | --- |"]
    for pr in report["prs"]:
        lines.append("| " + " | ".join(cell(s) for s in [f"#{pr['number']} {pr['title']}", pr["state"],
            pr["decision"]["tier"], "ready" if pr["gate"]["allowed"] else "blocked", "; ".join(pr["decision"]["reasons"]), pr["body"]]) + " |")
    lines += ["", "## Incidents", ""]
    for event in report["incidents"]:
        lines.append(f"- {event['ts']} · {event['type']} · PR #{event.get('pr')} · `{event.get('commit', '')[:8]}`" +
                     (f" · partner #{event['partner_pr']}" if event.get("partner_pr") else ""))
    if not report["incidents"]:
        lines.append("No recorded incidents.")
    lines += ["", "## Breaker floors", ""]
    for folder, state in report["breaker"]["folders"].items():
        lines.append(f"- `{folder}` → tier {state['floor']}: {state['reason']}")
    if not report["breaker"]["folders"]:
        lines.append("No active floors. Loosening always requires human approval.")
    return "\n".join(lines) + "\n"


def html(report: dict) -> str:
    cards = []
    for pr in report["prs"]:
        tier = pr["decision"]["tier"]
        reasons = "".join(f"<li>{escape(reason)}</li>" for reason in pr["decision"]["reasons"])
        notes = "".join(f"<p class='note'>{escape(i['message'])}</p>" for i in pr["sync"]["issues"])
        cards.append(f"""<article data-state="{escape(pr['state'])}" data-tier="{tier}">
<div class="pr-top"><span class="pr-number">#{pr['number']:02}</span><span class="pill tier-{tier}">TIER {tier} · {tier} HUMAN{'S' if tier != 1 else ''}</span><span class="state">{escape(pr['state'])}</span></div>
<h3>{escape(pr['title'])}</h3><p class="meta">{escape(pr['author'])} <span>→</span> main · <code>{pr['head'][:8]}</code></p>
<ul>{reasons}</ul>{notes}<details><summary>Decision evidence</summary><pre>{escape(pr['body'])}</pre>
<p>Gate: {'ready' if pr['gate']['allowed'] else 'blocked'} · eligible approvals: {len(pr['gate']['eligible'])} / {pr['gate']['required']}</p>
<p>Checked against main <code>{pr['checked_main'][:8]}</code>. Rechecked at merge time.</p></details></article>""")
    incident_rows = "".join(f"<tr><td>{escape(e['type'])}</td><td>#{e.get('pr', '—')}</td><td><code>{escape(e.get('commit', '')[:8])}</code></td><td>{'#' + str(e['partner_pr']) if e.get('partner_pr') else '—'}</td><td>{escape(', '.join(e.get('paths', [])))}</td></tr>" for e in report["incidents"])
    floors = "".join(f"<p><code>{escape(folder)}</code> <strong>tier {state['floor']}</strong> · {escape(state['reason'])}</p>" for folder, state in report["breaker"]["folders"].items())
    zero = sum(p["decision"]["tier"] == 0 for p in report["prs"])
    blocked = sum(p["state"] == "open" and not p["gate"]["allowed"] for p in report["prs"])
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mergeguard · review desk</title>
<style>
:root{{--bg:#f4f3ed;--ink:#192a29;--muted:#5c6d69;--line:#d6dcd3;--green:#155b43}}*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,sans-serif}}main{{max-width:1180px;margin:auto;padding:40px 32px 70px}}header{{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:22px}}.logo{{font-size:23px;font-weight:800;letter-spacing:-1px}}.logo b{{color:#358262}}.eyebrow{{text-transform:uppercase;letter-spacing:2px;font-size:11px;color:var(--muted)}}h1{{font-size:clamp(36px,6vw,64px);line-height:1.08;font-weight:650;letter-spacing:-3px;margin:42px 0 18px}}.intro{{max-width:620px;font-size:18px;color:var(--muted)}}.stats{{display:grid;grid-template-columns:repeat(4,1fr);margin:34px 0;border:1px solid var(--line);background:#fffef9}}.stat{{padding:22px;border-right:1px solid var(--line)}}.stat:last-child{{border:0}}.stat strong{{display:block;font-size:34px;line-height:1.2}}.stat span{{font-size:12px;color:var(--muted)}}.section-title{{display:flex;align-items:center;justify-content:space-between;margin:38px 0 16px}}h2{{font-size:21px;letter-spacing:-.6px}}select{{padding:9px 14px;background:transparent;border:1px solid var(--line);border-radius:6px;color:var(--ink)}}.cards{{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}}article{{background:#fffef9;border:1px solid var(--line);border-radius:8px;padding:24px;min-width:0}}.pr-top{{display:flex;align-items:center;gap:12px}}.pr-number{{font:14px monospace;color:var(--muted)}}.pill{{font-size:10px;letter-spacing:.6px;font-weight:750;padding:5px 9px;border-radius:4px}}.tier-0{{background:#e3f1e6;color:#1c623d}}.tier-1{{background:#f8eecf;color:#7a5c14}}.tier-2{{background:#f7ded6;color:#923e28}}.state{{margin-left:auto;font-size:12px;color:var(--muted)}}h3{{font-size:21px;line-height:1.3;margin:18px 0 8px}}.meta{{font-size:12px;color:var(--muted)}}.meta span{{padding:0 5px}}ul{{padding-left:18px;font-size:13px;color:var(--muted)}}li{{margin:5px 0}}code{{font-size:12px}}details{{border-top:1px solid var(--line);margin-top:18px;padding-top:14px;font-size:12px}}summary{{cursor:pointer;color:var(--green);font-weight:650}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;font-size:11px}}.note{{font-size:12px;border-left:3px solid #b86a3a;padding:10px;background:#fff4e4}}.table-wrap{{overflow:auto}}table{{width:100%;border-collapse:collapse;font-size:12px;text-align:left}}th,td{{padding:13px 10px;border-bottom:1px solid var(--line)}}th{{color:var(--muted);font-weight:500}}.breaker{{background:#e5ece2;padding:20px 24px;border-radius:8px;margin-top:28px;font-size:13px}}.breaker h2{{margin-top:0}}footer{{margin-top:38px;color:var(--muted);font-size:11px}}[hidden]{{display:none!important}}@media(max-width:700px){{main{{padding:24px 18px}}.cards{{grid-template-columns:1fr}}.stats{{grid-template-columns:1fr 1fr}}.stat{{border-bottom:1px solid var(--line)}}header .eyebrow{{display:none}}h1{{letter-spacing:-2px}}}}
</style></head><body><main><header><div class="logo"><b>↳</b> mergeguard</div><div class="eyebrow">Main is the meeting point</div></header>
<p class="eyebrow" style="margin-top:38px">Review desk / offline demo</p><h1>More agents.<br>A calmer main.</h1><p class="intro">Specific sync notes. Proportional human review. An incident trail that makes the next merge safer.</p>
<div class="stats"><div class="stat"><strong>{len(report['prs']):02}</strong><span>pull requests</span></div><div class="stat"><strong>{zero:02}</strong><span>proven low risk</span></div><div class="stat"><strong>{blocked:02}</strong><span>waiting at the gate</span></div><div class="stat"><strong>{len(report['breaker']['folders']):02}</strong><span>raised review floors</span></div></div>
<div class="section-title"><h2>Review decisions</h2><label><span class="eyebrow">Show </span><select id="filter" aria-label="Filter review decisions"><option value="all">All PRs</option><option value="open">Open</option><option value="merged">Merged</option><option value="2">Tier 2</option></select></label></div><div class="cards">{''.join(cards) or '<p>No pull requests yet.</p>'}</div>
<div class="section-title"><h2>Incident trail</h2><span class="eyebrow">Append only</span></div><div class="table-wrap"><table><thead><tr><th>Event</th><th>PR</th><th>Commit</th><th>Partner</th><th>Paths</th></tr></thead><tbody>{incident_rows or '<tr><td colspan="5">No incidents recorded.</td></tr>'}</tbody></table></div>
<section class="breaker"><h2>Learning without silent relaxation</h2>{floors or '<p>No incident clusters have raised a review floor.</p>'}<p>Tightening is automatic. Loosening needs a human-approved policy change.</p></section><footer>Generated {escape(report['generated_at'])} · Saved decision snapshots. Every merge recomputes policy, sync, breaker floors, and approvals against current main.</footer>
</main><script>document.getElementById('filter').addEventListener('change',e=>{{for(const card of document.querySelectorAll('article')){{card.hidden=!(e.target.value==='all'||card.dataset.state===e.target.value||card.dataset.tier===e.target.value)}}}})</script></body></html>"""


def generate(repo=".", output: str | None = None) -> str:
    report = data(repo)
    if output:
        target = Path(output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(html(report))
    return markdown(report)
