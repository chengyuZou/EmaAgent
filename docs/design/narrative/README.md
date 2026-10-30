# Why story retrieval works this way

[中文](README-zh.md) | [Documentation](../../README.md)

Narrative gives conversations about the original story supporting passages while preserving the timelines and events the user asked about. We want to reduce invented recollections while controlling retrieval cost and how much material the main Agent must read.

## Why we adopted LightRAG

In December 2025, EmaAgent was an early Python prototype. The hand-written RAG approach was not working well, and development experience was limited. After encountering LightRAG, a small trial produced acceptable results, so we adopted it.

This was not the conclusion of an exhaustive comparison of retrieval methods. An existing solution helped move the prototype forward, with an incomplete understanding of its algorithm and data limitations. Later experiments re-examine those choices; they do not retroactively turn the initial trial into a thoroughly validated selection.

## Why we separate timelines

The early trial compared putting the whole story together, separating it by playthrough, and splitting it further by chapter. Playthrough separation worked best in that small trial and became the retained organization.

Events and character outcomes can differ across playthroughs. Keeping that scope helps avoid combining different versions of a character's experience into a single event. Cross-playthrough comparisons require evidence from each relevant timeline, with the additional retrieval cost that entails.

The trial had few questions and imperfect data, however. The old parser mapped 泽渡可可 to the incorrect 泽度可可, and some old data was garbled. Those conditions do not establish playthrough separation as an optimal organization or make every retrieval gap an algorithm problem.

Story order also needs to be distinguished from derived speaker and choice labels. Correct ordering in the original assembled material does not establish that every derived label is correct; the storage order of underlying localization files is not suitable as story order either. We accept that parts of the material still need organization and preserve the need to check the original text.

## Why we preserve intent and separate routing from extraction

The question can drift in two places: when the main Agent writes a tool query, and when Narrative rewrites it internally. If each step adds its own interpretation, retrieval can end up searching for support for a guess.

The query-preparation comparison showed added assumptions and lost scope. A question about whether someone died immediately after falling produced an extra query about death before the fall. The old router also inserted a culprit's name from its story summary even though the question did not mention that person. A correct presumed answer still should not become a fact supplied by the user.

We therefore preserve the question's meaning rather than require a verbatim copy. Known conversation context may resolve a person, pronoun, or timeline, but must not supply a guessed answer. If the conversation explicitly concerns 城崎诺亚 in the third playthrough, her final whereabouts can be queried with that name and scope. It must not be changed into a question about why she stayed in prison.

Narrative no longer creates replacement queries for each timeline. Timeline selection and keyword extraction use two independent calls. Selection may read the story summary to establish scope; extraction reads the query without that summary or the selection result. We do not want textual instructions inside a combined request to be the only separation between reading answer-bearing background and extracting terms solely from the question.

The cost is two model requests and their charges. They can run concurrently, but concurrency does not remove request cost or ensure correct interpretation. Independent extraction still turned an instruction not to discuss an execution into a positive execution keyword in the comparison. Separating inputs reduces opportunities to mix information without solving all negation and ambiguity.

## Why we limit rerank input and returned evidence

The separate Ema-Narrative experiments collected evidence comparisons on 2026-10-24. One manual review of the old approach used complete questions, all retrieved candidates as rerank input, and at most 8 returned chunks per timeline. Core information was covered for 95 of 100 questions; 5 still lacked required evidence.

These observations changed how we understood the gaps:

| Observation | Consequence for the choice |
| --- | --- |
| In 2 of the 5 gaps, required evidence reached rerank but missed the first 8 results; in 3, the required scene never entered the candidates | Increasing the returned count can help one kind of gap, but cannot recover a candidate that was never found |
| Full-candidate hybrid, naive, and mix comparisons did not automatically resolve those 5 gaps | Changing mode is not a general remedy; that comparison focused its re-review on the known gaps rather than reporting a new overall coverage rate for all three modes |
| In a separate five-question full-ranking comparison, the note and book passages ranked first once included, while other required disclosures ranked 14th, 17th, or 92nd | Removing upstream restrictions can help some questions, while a larger return range or imperfect ranking can remain relevant |

The 95 questions measure core evidence coverage under those old conditions, not the main Agent's final-answer accuracy. The five-question comparison bypassed several restrictions together, so it also cannot identify one parameter as the sole cause.

Sending every retrieved candidate to rerank reduces evidence lost before ranking, but increases input volume and cost. Returning more original text increases the main Agent's context and reading burden. Even returning every chunk still requires interpreting the competing accounts in the story correctly.

We chose bounded candidate and return ranges. Current limits send at most 125 candidates per timeline and request at most 30 ranked chunks, with an additional text budget across the whole query. The candidate limit takes the existing merge order rather than a previously established global relevance ranking. We accept the possibility of cutting useful evidence to keep individual input costs bounded.

These values express the project's current cost/coverage tradeoff. The old comparisons are not complete answer-generation verification of the current 125/30 approach, nor do they establish universal values. Parameters can change without recording every tuning step in the design document.

## Limitations we currently accept

An original passage can still lead to a wrong answer. Trials contain guesses, lies, inner monologues, player choices, and overturned reasoning. Highly relevant dialogue may be an early accusation. We do not want to remove genuine story content simply to make search results look definitive, or treat all of it as the final verdict.

When a retrieved chunk labels its `speaker` as narration (旁白), the response may repeat "the narrator says" instead of conveying the character's own feelings from their perspective. Relevant evidence alone therefore does not ensure natural character expression; speaker labels and narrative perspective also influence the reply.

The current choice preserves original passages, reduces question rewriting, separates routing from extraction, and limits input/output cost. It can still miss evidence, choose the wrong timeline or keywords, or combine accounts from different stages. Data organization, retrieval omissions, and downstream interpretation need separate checks. One successful answer or parameter choice does not establish that the whole problem is solved.

If real questions repeatedly expose the same omission, or the current organization cannot preserve necessary context, compare data organization, retrieval, or ranking approaches for that failure class. See the [Narrative module](../../../src/narrative/README.md) and [parameter definitions](../../../src/narrative/pipeline/constants.ts) for interfaces and current values.

