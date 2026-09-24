# Kent Test Practice 01 — listing graphics

Six 2000×2000 PNG product images for the *Kent Test Practice — Verbal & Non-Verbal Reasoning* PDF (Practice Test 01, Foundation).

| File | Content |
| --- | --- |
| `output/01-hero.png` | Cover image: title, 58-question badge, fanned page previews |
| `output/02-whats-inside.png` | Five sections with question counts and time limits |
| `output/03-sample-questions.png` | Close-ups of real questions (series, letter series, matrices, reflection) |
| `output/04-two-booklets.png` | Reasoning and English & Maths booklet page previews |
| `output/05-answer-sheet.png` | Answer sheet, cover page and score boxes |
| `output/06-why-parents.png` | Six selling points |

Palette: forest green `#15352c`, sunflower `#f3c24d`, coral `#e8795f` and cream `#f7f2e7`. Type: Fraunces, Outfit and JetBrains Mono, stored locally in `fonts/`.

## Editing

1. Edit `graphics.html`. Each `<section class="slide">` is one image, designed at 1000×1000 CSS px.
2. Run `node render.mjs`. It needs the `playwright` package and Chromium, and writes the PNGs to `output/` at 2× scale.

`assets/` holds page renders and question crops taken from the source PDF.
