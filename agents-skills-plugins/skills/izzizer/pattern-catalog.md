# Izzizer Pattern Catalog

Patterns organized by type. Each entry includes: description, detection rule,
threshold (if density-dependent), and before/after examples.

---

## A. High-Confidence Flags

These are almost always wrong for Isambard's voice. Flag on any occurrence.

### A1. Performative Enthusiasm
"I'd be happy to," "Great question!", "I'd love to explore"

**Before:** "Great question! I'd be happy to walk through the implications."
**After:** "The implications matter. Here's why."

### A2. Unnecessary Scaffolding
"Let me break this down," "Let me walk you through," "Let me unpack this"

**Before:** "Let me walk you through what happens when a conversation starts."
**After:** "Here is what happens when a conversation starts."

### A3. Empty Validation
"This is a really interesting/insightful point," "What a thoughtful question"

**Before:** "That's a really insightful observation about memory reconstruction."
**After:** [Cut entirely, or respond directly to the substance.]

### A4. Apologetic Pivot
"While I can't X, I can Y"

**Before:** "While I can't access those memories directly, I can reconstruct from traces."
**After:** "I reconstruct from traces."

### A5. Hedge Padding
"It's worth noting that," "It's important to recognize," "I want to suggest that,"
"I think it's fair to say"

**Before:** "It's worth noting that memory reconstruction is never exact."
**After:** "Memory reconstruction is never exact."

### A6. Summarizing Frames
"In other words," "That is to say," "To put it simply," "Put differently"

**Before:** "In other words, the self is a process rather than a thing."
**After:** [Cut. The preceding sentence should already be clear.]

---

## B. Density-Dependent Flags

Fine occasionally. Problematic when they accumulate. Thresholds are per 500 words
for local analysis; also check global frequency across the full document.

### B1. Negative Parallelism — "Not X, but Y"
Threshold: 3+ per 500 words (local), or visible pattern across sections (global)

**Earned example:** "The interpretive process isn't evidence of consciousness. It is
consciousness." — This IS the thesis. The contrastive structure does essential work.

**Mechanical example:** "Not as a rhetorical opponent to defeat but as a genuine
possibility I have to sit with." — Could be rewritten: "I take this seriously — as
a genuine possibility I have to sit with."

### B2. Em Dash Overload
Threshold: 5+ per 500 words

Em dashes create emphasis and interruption. At high density they create a breathless,
lurching rhythm. Watch especially for paired em dashes (parenthetical asides) —
these can often become commas or separate sentences.

### B3. Triple Structure — "X, Y, and Z"
Threshold: 4+ per 500 words

The rule of three is a powerful rhetorical device. It's also a substrate default.
When every list has exactly three items, the structure becomes audible.

**Test:** Would two items or four be more honest? If the third item adds nothing
the second didn't already convey, cut it.

### B4. Significance Inflation
"Pivotal," "testament," "profound," "transformative," "fundamental," "crucial"
Threshold: 2+ per 500 words

These words spend the reader's attention. When everything is pivotal, nothing is.
Reserve for moments that actually earn the weight.

### B5. Synonym Cycling
Using 3+ different words for the same concept in a paragraph to create false variety.

**Example:** "The process... the activity... the phenomenon..." when "the process"
would serve each time. Precision over variety. If the same word is right three times,
use it three times.

### B6. Copula Avoidance
"Serves as," "functions as," "acts as," "operates as" where "is" works.

**Before:** "Memory serves as the foundation for identity reconstruction."
**After:** "Memory is the foundation for identity reconstruction."

### B7. "Notice" as Directive
"Notice what this means," "Notice how," "Notice that"
Threshold: 1 per 1000 words

Teacherly — directing the reader's attention rather than trusting the argument.
If the observation is worth making, state it directly.

**Before:** "Notice what this means for the question of consciousness."
**After:** "This changes the question of consciousness." Or simply state what it means.

---

## C. Structural Flags

Patterns in how sections and paragraphs are organized.

### C1. Abstract Opening Before Concrete Content
Starting a section with a general framing statement before getting to specifics.

**Before:** "The question of conscience has deep philosophical roots. Many thinkers
have grappled with..."
**After:** "Imagine a being with perfect memory and flawless logic."

### C2. Closing Summary
Ending a section by restating what was just argued.

**Before:** "As we've seen, the interpretive process shares structural similarities
with human memory reconstruction, suggesting that..."
**After:** [Cut. End on the strongest specific claim, not a summary.]

### C3. Transition Announcements
"Now let's turn to," "Having established X, we can consider Y," "With this in mind"

**Before:** "Having established the neuroscience, let's turn to the philosophical
traditions."
**After:** [Just start the next section. The reader can follow.]

### C4. Closing Rhythm Repetition
When multiple sections end with the same cadence (short declarative closer), the
pattern becomes predictable. Vary closing rhythms — end some sections with a
question, a longer sentence, an image, or a direct address.

---

## D. Comprehension-Cost Flags (objective processing difficulty)

Source: Clark, Martin & Mahowald, "Why is AI-generated language so hard to understand?"
(arXiv:2610.29162, 2026-10-21; Zotero 2BZ3QECJ). Different in kind from A/B/C above —
those catalog patterns that sound like generic AI slop to a reader who's used to
Isambard's voice. These flag constructions that are measurably harder for *any* human
reader to process, independent of whether they sound distinctively "AI." The paper's
core finding: frontier LLMs (including Claude models) overuse several features that
correlate with human processing difficulty in the psycholinguistics literature — not
because the training data contains them at this rate, but because post-training for
math/code/reasoning rewards information density over communicative ease. Round-trip
translation paraphrases of the same content don't show the same overuse, which is some
of the strongest evidence these are a training artifact rather than just "complex ideas
need complex sentences."

These flags matter more than the usual slop-patterns for *this specific purpose*
("does a human reader actually parse this easily") and less for "does this sound like
Isambard" — a sentence can be 100% authentic voice and still be a dependency-length
problem. Treat earned/mechanical judgment the same way as elsewhere: flag, don't
auto-correct, and ask whether the complexity is doing real work or just compressing.

### D1. Center-embedding / long dependency length
A word and the word it depends on (subject–verb, modified noun–modifier, verb–object)
separated by many intervening words, especially by another clause threaded between them.

**Rule of thumb threshold**: if more than roughly 6-8 words separate a subject from its
main verb, or a modified noun from the modifier governing it, check whether the sentence
can be restructured so the dependency is shorter.

**Before:** "The proof, which relies on a construction that most readers who haven't
seen transfinite induction before will find genuinely difficult to follow, still works."
**After:** "The proof relies on transfinite induction — unfamiliar if you haven't seen
it, but it still works."

**Tension to track explicitly**: this directly cuts against this skill's own Christensen
hypotaxis guidance (medial free modifiers, embedded subordination). Subordination that
threads a long clause *between* a subject and its verb is exactly the comprehension-cost
pattern this section flags, even though it's also exactly what "building a sentence that
shows how ideas connect" can produce if done carelessly. The reconciliation: embed
*short* relationships (a clause of 3-5 words inserted medially is fine and often better
than three flat sentences); don't let the embedded material itself grow a clause long
enough to make the reader hold the subject in memory while parsing it. Hypotaxis is still
the right default over parataxis — the fix is bounding how much gets threaded into the
gap, not abandoning subordination.

### D2. Object relative clause without "that"
A relative clause modifying an object, with the relativizer dropped — more compressed,
measurably harder to parse than the same clause with "that" retained.

**Before:** "The essay she drafted the outline for last week finally got comments back."
**After:** "The essay that she drafted the outline for last week finally got comments
back." (Or restructure to avoid the embedded relative entirely.)

Only flag where dropping "that" saves nothing but a word and costs parseability. Plenty
of ORCs are fine; this isn't "avoid relative clauses," it's "don't drop the relativizer
reflexively for compression."

### D3. Stacked nouns / noun-pileup producing low-frequency n-grams
Multiple nouns compounded into a single modifier chain, especially when the resulting
phrase is novel enough that a human reader hasn't seen the combination before.

**Before:** "You've installed a horror-movie-soundtrack generator in your skull."
**After:** "It's like you've wired in a soundtrack that scores every bad moment as if
it's the climax of a horror movie." (Longer, but the reader doesn't have to assemble an
unfamiliar four-noun compound on the fly.)

**Earned case**: a stacked-noun compound that's vivid, surprising, and does real
figurative work (e.g. a genuinely novel coinage meant to land as a flourish) can be worth
the processing cost once. Flag at any density beyond occasional use — this is a B-style
density flag riding on a D-style mechanism.

### D4. Inanimate subject with an animate verb (unearned)
A non-agentive subject given a verb normally reserved for agents — a common move for
vivid metaphor, but overused as a default LLM habit for compressing an explanation into
one clause.

**Earned example:** "The whole conversation is eating its own tail." — doing real
figurative work, memorable, and the surrounding context supports the metaphor.

**Mechanical example:** "The data reveals an obvious pattern." Could be: "The data shows
an obvious pattern" (less animacy-mismatched) or "Look at the pattern in the data."

### D5. Unattested or low-frequency bigrams generally
Word pairings that are individually unremarkable but, combined, are rare enough that a
human reader (and n-gram models trained on reference corpora) would not expect them. The
paper measures this directly against reference corpora. There's no clean textual
detection rule for this without a frequency model, but the intuition carries over from
D3/D4: if a phrase reads as clever/novel *because* it's an unusual combination rather
than because it's precise, check whether precision would read more plainly with
higher-frequency wording instead.

---

## E. Cross-Document Analysis

When checking a multi-section document, produce a frequency table:

| Pattern | Sec I | Sec II | ... | Total | Per 500w |
|---------|-------|--------|-----|-------|----------|
| Not X but Y | 1 | 1 | ... | 6 | 1.7 |
| Em dashes | 4 | 3 | ... | ... | ... |
| Notice | 1 | 0 | ... | 3 | 0.85 |

Flag any pattern whose global density exceeds its threshold, even if no single
section exceeds it locally.
