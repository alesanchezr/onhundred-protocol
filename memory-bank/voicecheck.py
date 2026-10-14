#!/usr/bin/env python3
"""voicecheck.py: enforce VOICE.md rule zero (plain English).

Usage: python3 voicecheck.py FILE [FILE ...]   (.html or .md)
Exit code 1 if any check fails.

Checks
  1. Banned words (complicated terms and hype), with the plain swap.
  2. Sentences over MAX_WORDS words.
  3. Sections that read above MAX_GRADE (Flesch-Kincaid grade).
Skipped: the changelog, <style>, <script>, and anything marked data-voice="skip".
"""
import re, sys
import textstat
from bs4 import BeautifulSoup

MAX_WORDS = 20
MAX_GRADE = 8.0

# pattern -> plain swap. Case-insensitive unless the key starts with "(?-i)".
BANNED = {
    r"inventor(y|ies)": "your list",
    r"owners?": "you / the person running it",
    r"participants?": "you / the person running it / employees",
    r"(reference )?applications?": "run / Ale's own run",
    r"branch(es)?": "part (of life)",
    r"baselines?": "what it costs today",
    r"timed": "measured",
    r"occurrences?": "each time it happens",
    r"triage": "score",
    r"slots?": "pick",
    r"stages?": "round",
    r"holding( period)?": "proving it / prove it for 3 weeks",
    r"flags?": "status",
    r"ceilings?": "limit",
    r"evals?": "goal",
    r"success (tests?|criteri(a|on))": "goals",
    r"hypothes[ie]s": "your bet",
    r"cycles?": "the 2 weeks between check-ins",
    r"assisted": "help me",
    r"(?-i:Delegated)": "do it, I approve / handed off",
    r"autonomous": "do it alone",
    r"parameters?": "number / setting",
    r"metrics?": "number",
    r"criteri(a|on)": "what counts / rule",
    r"thresholds?": "minimum",
    r"achieved": "passed",
    r"terminated": "stopped",
    r"pre-?regist(er|ered|ration)": "write it down before you start",
    r"aggregated?": "total / combined",
    r"comparability": "so results can be compared",
    r"procedures?": "steps",
    r"methodology": "method",
    r"frameworks?": "method",
    r"implement(s|ed|ing)?": "do",
    r"utili[sz](e|es|ed|ing)": "use",
    r"facilitat(e|es|ed|ing)": "help",
    r"commenc(e|es|ed|ing)": "start",
    r"iterat(e|es|ed|ing)": "try again",
    r"optimi[sz](e|es|ed|ing)": "improve",
    r"workflows?": "setup / steps",
    r"stakeholders?": "the people involved",
    r"subsequent(ly)?": "next / later",
    r"prior": "before",
    r"regarding": "about",
    r"verifiable": "can be checked",
    r"material harm": "real harm",
    r"(un)?mapped": "still yours / measured",
    # hype
    r"leverag(e|es|ed|ing)": "use", r"unlock(s|ed|ing)?": "(cut it)", r"empower(s|ed|ing)?": "(cut it)",
    r"revolutioni[sz]e": "(cut it)", r"game-?changer": "(cut it)", r"seamless(ly)?": "(cut it)",
    r"cutting-edge": "(cut it)", r"supercharg(e|es|ed|ing)": "(cut it)", r"journey": "(cut it)",
    r"delve": "(cut it)", r"robust": "(cut it)", r"ai-powered": "(cut it)", r"10x": "(cut it)",
    r"in today's world": "(cut it)", r"the future of work": "(cut it)",
}
COMPILED = []
for pat, swap in BANNED.items():
    if pat.startswith("(?-i:"):
        COMPILED.append((re.compile(r"\b" + pat + r"\b"), pat, swap))
    else:
        COMPILED.append((re.compile(r"\b" + pat + r"\b", re.I), pat, swap))

BLOCK = ["p", "li", "td", "th", "h1", "h2", "h3", "h4", "div", "br", "pre", "tr", "section", "span"]


def sections_html(path):
    soup = BeautifulSoup(open(path, encoding="utf-8").read(), "html.parser")
    for t in soup(["style", "script", "svg"]):
        t.decompose()
    for t in soup.select('[data-voice="skip"], #cl'):
        t.decompose()
    # code-looking spans (loop codes, labels in mono) stay; they're short.
    for t in soup.find_all(BLOCK):
        t.insert_before("\n")
        t.insert_after("\n")
    out = []
    for sec in soup.find_all("section"):
        h = sec.find(["h1", "h2"])
        title = h.get_text(" ", strip=True) if h else (sec.get("id") or "section")
        out.append((title, sec.get_text("")))
        sec.decompose()
    return out


def sections_md(path):
    text = open(path, encoding="utf-8").read()
    text = re.split(r"^## (Changelog|What changed)\s*$", text, flags=re.M)[0]
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    parts = re.split(r"^(#{1,2} .*)$", text, flags=re.M)
    out, title = [], "top"
    for p in parts:
        if re.match(r"^#{1,2} ", p):
            title = p.lstrip("# ").strip()
        else:
            out.append((title, p))
    return out


def sentences(text):
    lines = [l.strip() for l in text.split("\n")]
    lines = [re.sub(r"^[-*\d.]+\s+", "", l).replace("|", "\n") for l in lines if l.strip()]
    out = []
    for l in "\n".join(lines).split("\n"):
        l = l.strip(" *_`")
        if not l:
            continue
        for s in re.split(r"(?<=[.!?:;])\s+(?=[A-Z0-9\"(])", l):
            s = s.strip()
            if s:
                out.append(s)
    return out


def check(path):
    secs = sections_html(path) if path.endswith(".html") else sections_md(path)
    problems = 0
    print(f"== {path}")
    for title, text in secs:
        sents = sentences(text)
        body = " ".join(sents)
        if not body.strip():
            continue
        hits = []
        for rx, pat, swap in COMPILED:
            for m in rx.finditer(body):
                hits.append((m.group(0), swap))
        longs = [s for s in sents if len(s.split()) > MAX_WORDS]
        words = len(body.split())
        grade = textstat.flesch_kincaid_grade(body) if words >= 60 else 0
        bad_grade = grade > MAX_GRADE
        if hits or longs or bad_grade:
            print(f"\n-- {title}  (grade {grade:.1f}, {words} words)")
            seen = {}
            for w, swap in hits:
                seen[w.lower()] = (seen.get(w.lower(), (0, swap))[0] + 1, swap)
            for w, (n, swap) in sorted(seen.items()):
                print(f"   BANNED  {w!r} x{n} -> {swap}")
            for s in longs:
                print(f"   LONG({len(s.split())})  {s[:160]}")
            if bad_grade:
                print(f"   GRADE   {grade:.1f} > {MAX_GRADE}")
            problems += len(hits) + len(longs) + int(bad_grade)
    total = " ".join(" ".join(sentences(t)) for _, t in secs)
    print(f"\n== {path}: overall grade {textstat.flesch_kincaid_grade(total):.1f}, problems {problems}")
    return problems


if __name__ == "__main__":
    n = sum(check(p) for p in sys.argv[1:])
    sys.exit(1 if n else 0)