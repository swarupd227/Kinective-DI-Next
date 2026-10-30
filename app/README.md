# DI Next app

The DI Next code lives in this folder. The specification, backlog and feature inventory are in the folder above.

- **Slice 0, the UX foundation:** design tokens, base components, the generative UI block library, the stream protocol client and a mock Experience Layer.
- **Slice 1, the shell:** the five-region application shell, the Home daily briefing, conversation threads, context chips, the command palette, notifications, the agent activity rail and the workspace pane.
- **Slice 2, real answers:** a synthetic tenant warehouse in MySQL, the semantic layer over it, and the DI Concierge with the Analytics Q&A agent on Claude. Home's figures, the Loan Accounts grid and data questions now come from the warehouse.
- **Slice 3, a real write through an approval card:** the Referral agent on Claude, a workflow store and DI Core referral operations, a tool gateway, and an approval service. A referral is drafted from the conversation, routed by the DI Core's rules, approved on a card, and then created exactly as approved, once, with an audit trail from the record back to the run and the approval. Incentive payouts and retention still play scripted runs.
- **Slice 4, push-to-talk voice:** a voice gateway in the Experience server with an Azure AI Speech adapter, banking-aware transcript normalisation, spoken answers with live captions and barge-in, and the spec's voice rules for approvals.
- **Slice 6, Reports and the Report Builder:** one report definition format (settings plus widgets on a 12-column grid, each a semantic query), stock periodic reports, the `report_canvas` block with controls that re-run in place and agent edits you accept or revert, the Report Builder agent on Claude, approved save, schedule and export (Excel and CSV), and the Reports app.
- **Slice 5, Member 360 and the Relationship agent:** relationship data in the warehouse, a DI Core relationship service (search by name, number, phone or email; the 360 profile; score explanations; the next best conversation; "Member declined"), the `member_card` and `member_360` blocks, the Relationship agent on Claude, a member workspace and page, and the spoken-number picker.
- **Slice 8, the agent you hand work to:** a Goal agent that plans, works across data and reports, takes instructions while it runs and stops for approval; a task-based layout with your tasks on the left, the conversation in the middle and progress and outputs beside it; a new Home; and a warmer visual language with a serif voice for the agent.

**Azure demo:** one container (the Experience server serving the built shell) on Azure Container Apps, with Azure Database for MySQL, behind a demo access code. [`deploy/azure/README.md`](deploy/azure/README.md) has the Cloud Shell commands. Try the image locally with `docker build -t dinext .` and `docker run -p 8788:8787 -e DI_DB_URL=mysql://dinext:dinext_local@host.docker.internal:3307 -e DI_DEMO_ACCESS_CODE=letmein dinext`.

## Run it

Requires Node 22 or later and Docker Desktop.

```bash
npm install
npm run db:up
npm run db:seed
npm run dev
```

`npm run dev` starts the Experience server on port 8787 and the DI Next shell on http://localhost:5174. `npm run dev:workbench` starts the block workbench on http://localhost:5173 instead. The server's first log line says which mode it is in:

| Mode | When | What answers |
|---|---|---|
| Live agents on Claude | The warehouse is up and `DI_ANTHROPIC_API_KEY` is set in `app/.env` (see `.env.example`) | The Concierge routes with Haiku; Analytics Q&A runs a tool loop with Opus against the semantic layer; the Referral and Relationship agents run on Sonnet through the tool gateway |
| Offline planner | The warehouse is up and there is no key, or the server was started with `npm -w @dinext/mock-stream-server run start:offline` | Deterministic planners answer simple metric questions and read simple referral and member requests, and say they are offline. No API calls |
| Scripted scenarios | No warehouse, or `DI_SCRIPTED=1` | The Slice 1 scripts |

Live mode spends API credit. Every turn's tokens and cost are in `app/.data/audit/<date>.jsonl`.

### How an answer is built (Slice 2)

1. **Pre-screen** masks SSNs, card numbers and account numbers before any model sees the text (spec 26.4).
2. **Concierge** refuses core writes in code, then classifies with the fast model and routes from the routing table.
3. **Analytics Q&A** searches the semantic catalog first. A first question with terms the model has no definition for is refused without a model call and logged to `app/.data/unmatched-questions.jsonl`.
4. The model calls `semantic_query` with a structured request. The semantic layer compiles it to parameterised SQL with the user's purview applied, so the model never sees purview lists or rows it may not see.
5. The model answers through `submit_answer`, with `{{placeholders}}` for every figure. Code computes each figure from the query rows. A sentence with a number the model typed itself is removed before it streams, and charts and tables are built from the full results.

### How a write is made (Slice 3)

1. The **Referral agent** finds the member with `relationship_party_search`, which only returns people in the user's purview and gives the model `MBR_n` tokens, never IDs.
2. It calls `referral_create`. The **tool gateway** rejects reserved keys (user, tenant, purview, IDs), checks the fields against the type's form (no invented fields), computes routing in the DI Core, sets the risk tier from the tool's metadata, and stores an **approval** bound to the exact payload hash, the user and a 15-minute expiry. Nothing is created yet.
3. Code writes the card and the "going to the Westport Lending Queue" text from the routing result. A follow-up such as "make it email instead" prepares a new card and expires the old one.
4. On **Approve**, the approval service checks the user, the payload hash and the expiry, and the gateway executes the stored payload with the approval ID as the idempotency key. A retry or double click cannot create a second referral. The confirmation ("Referral #88227 … Ana Ruiz has it") is written from the created record.
5. Audit events `ai.approval.requested`, `ai.approval.approved` / `denied` / `superseded` and `ai.action.executed` go to `app/.data/audit`, and the referral row stores its run and approval IDs.

The application database account can only `SELECT` the warehouse, and `INSERT` / `UPDATE` the workflow tables (COMs, approvals, declines, report templates, schedules and exports). It cannot delete anything.

### Voice (Slice 4)

Voice needs an Azure AI Speech resource: put `DI_AZURE_SPEECH_KEY` and `DI_AZURE_SPEECH_REGION` in `app/.env` and restart the server. Its log line then ends with `voice: azure`. Without them the microphone shows why voice is off, and everything else works as before. To try the voice UI with no Azure key, start the server with `npm -w @dinext/mock-stream-server run start:demo-voice`: a fake recogniser "hears" four sample phrases in turn, speech is silent, and captions still show. It is for developers only.

How it works (spec 7):

1. **Hold the microphone** (or hold Space in an empty box, or press Ctrl+Shift+Space to start and stop). The browser captures 16 kHz mono PCM in an audio worklet and streams it over `/v1/voice` to the gateway, which holds the Azure credentials. The browser never talks to Azure, and no audio is stored.
2. A red dot, "Listening" and a level meter show while the microphone is open, with the words as they are heard.
3. On release, the gateway normalises the transcript for banking language: "two point five million dollars" becomes $2,500,000, "fifty bips" becomes 0.50% (50 bp), "Q three" becomes Q3, "sixty plus" becomes 60+ and "five three hundred" becomes the 5300 Call Report. SSNs and card numbers are removed before anything is stored.
4. The understood text goes in the input box and sends itself after 1.5 seconds; Edit or typing stops that. It waits for you instead when recognition confidence is low, or when it contains a member or account number (only the last four digits are kept, for an on-screen lookup).
5. Spoken requests use the normal message endpoint marked `inputChannel: "voice"`, so typed and spoken questions follow one path. Their answers are also spoken, a sentence at a time with a caption. Data answers end with "Based on last night's build", figures are said as words, and identifiers are read as their last four digits only. A run with nothing to say after 3 seconds says "Working on that".
6. **Barge-in:** pressing the microphone, Esc or Stop ends speech at once; the text stays on screen. The speaker button turns spoken answers off for you.
7. **Approvals by voice:** a medium-risk card is read back ("This will send 1 HELOC referral to the Westport Lending Queue. Say confirm, or press Approve."), and "confirm" counts only after that read-back has finished playing on this device; the server checks the same. Hedged answers such as "sure" or "okay, but…" do not count. A high-risk card always says "This needs your approval on screen", and voice can never approve it. The card records "(voice)" as the channel.

The recogniser is biased towards banking terms and the tenant's branch, product and staff names. Member names are never added to that list.

### Member 360 (Slice 5)

Run `npm run db:seed` once after pulling this slice: it adds the relationship tables and recreates both test tenants, which also clears referrals and declines made in earlier demos. Every warehouse figure the earlier slices use is unchanged.

1. **Find a member** by name ("Pull up Suzanne Jackson at Westport"), member number or its last four digits, phone or email, from the conversation or **Ctrl+K**. Search applies the user's purview in SQL and shows only name, masked number and branch. Someone outside the purview looks exactly like nobody.
2. **One match** shows a `member_card` (accounts, deposits, loans, attrition risk and next best product, each with **Why?**) and talking points. On desktop the full `member_360` opens in the workspace pane, and the member becomes a context chip, so "Why is her attrition risk medium?" needs no name. **Several matches** show a card for each and ask which one; the agent never guesses.
3. **The 360** has every section of today's Relationship Dashboard as keyboard tabs: Overview, Accounts (balance, 30-day change, fees), Digital, Cross-sell & growth (30/60/90 days), Loan apps (365 days), Engagement & retention (score factors), Opportunities, Interactions, Rewards, Contact and Household. The page at `/members/{token}` shows the same record; links carry an opaque token, never a member number.
4. **Talking points** come from a fixed ranking in the DI Core: pending applications, then retention risk, then product opportunities, then digital gaps. The model writes the wording for each topic; code shows the reason under it ("Attrition score 6 on a 0–10 scale; reason: …"). A talking point with a number that is not in the data is replaced by the topic's own headline.
5. **Refer** on a card or an opportunity starts the Referral agent with the member and product already chosen. **Member declined** prepares a low-risk card; on approval the suggestion is hidden for 90 days and the decline appears under Interactions.
6. **Every record view is audited** as `relationship.profile.viewed` in `app/.data/audit`, whether it came from the agent, the workspace or the page.
7. **Spoken numbers:** "Pull up member ending four five two one" shows "Did you mean:" with the members whose number ends 4521. Picking one sends the request with that member's chip instead of the number.

### Reports (Slice 6)

Run `npm run db:seed` once after pulling this slice: it adds the report tables and three standard reports (Branch scorecard, ALCO monthly pack, Executive summary).

1. **One definition format** (spec 18.2, AI-AGT-050). A report is its builder settings (period type, hierarchy control, classes) plus widgets: a KPI, chart, table or text, each a semantic query with a size on a 12-column grid. The Reports app, the agent and the exports all read the same definition.
2. **Running a report** builds every widget in code from the semantic layer, under the user's purview, so figures are the same as Analytics answers. The canvas shows its controls (month or quarter, and branch); changing one re-runs the report in place with no conversation turn. A period that is not built yet, or a branch outside your access, is replaced by the nearest allowed one with a note. A measure the catalog does not define shows as "not defined" instead of being invented.
3. **The Report Builder** opens reports by name and period ("Open the August branch scorecard for Northgate"), builds drafts from a description ("Build me a monthly ALCO pack with loan balance trend, deposit mix and delinquency ratio"), and changes drafts ("Make the deposit mix a bar chart"). Drafts are private and autosaved. Every agent change is outlined on the canvas with **Accept** and **Revert**; in edit mode each widget also has move, resize and remove buttons.
4. **Saving, scheduling and exporting are approved writes.** Save is medium risk and records the origin ("Created by Report Builder, approved by …"). A schedule always runs after the nightly build; the card shows when, the format, the recipients, what happens when there is no data, and that each recipient sees only their own data. More than 25 recipients or an outside address is high risk and needs the count typed. An export is medium risk; the approved file downloads from a link only its approver can use, and every download is logged.
5. **The Reports app** (`/reports`) has the library by folder, your drafts, and **Schedules** with each one's last result. **Run now** on the Schedules tab runs every schedule as the nightly build would, so the last-result column and Home's "Scheduled reports" can be seen working locally.

### Working toward a goal (Slice 8)

DI takes an outcome as well as a question. "Get me ready for Thursday's ALCO meeting" goes to the Goal agent (`packages/agents/src/goal.ts`), which lays out a plan and works through it:

1. Compares headline measures with the prior month-end and ranks what moved.
2. Finds where the largest splittable change came from, by branch and then by category.
3. Runs the pack, drafts a note in the user's voice, and stops at an approval card that shows the note in full.

The plan, outputs and sources sit beside the conversation, and the pack opens there when it is ready. Each output appears in the conversation as a card.

- **Instructions during the work:** a message sent while a task runs joins that run rather than starting another. "Look at Westport too" adds a step; anything else goes in the note.
- **Changing the note by talking:** "make it shorter", "mention the Westport review" or "send it to the Finance team" prepare a new card and retire the old one.
- **Asking when stuck:** if DI can't tell which meeting you mean, it asks and carries on from your answer.
- **Same guardrails:** code computes every figure, the note's figures are checked line by line against what was computed, purview applies to every query, and nothing is sent without approval. Sending records a row in `esp_report_shares`; delivery is simulated.

The live agent chooses its own steps through the same work as the offline planner, so the two cannot disagree on a figure.

Slice 8 adds a table: run `npm run db:seed` once locally, or start the seeding job again on Azure.

### Things to try in the shell

- **Hand over a task:** "Get me ready for Thursday's ALCO meeting" from Home. Add "Look at Westport too" while it works, say "make it shorter" at the note, then Approve.
- **Home** shows the briefing: approvals first (Review expands the card), what changed, things to look at with "Why?", your work, scheduled reports, pinned tabs and suggested questions.
- **Brief me**, a suggested question, or the conversation bar starts a thread. Try "Total loans by branch", "Show loan growth by branch for Q3 vs Q2", "How is the delinquency ratio calculated?", or, as Marcus, "Show Northgate loan balance" (refused: outside his purview).
- **Ctrl+K** opens the palette. It searches reports, tables, members, branches and threads, and Enter on free text asks DI.
- **Type / or @** in the conversation bar: / lists the slash commands your class permits, and @ adds a member, branch, employee or table as a context chip.
- **Explain** (the sparkle or ⓘ on a block) asks how a number is calculated. A **Loan Accounts** source chip opens the grid in the workspace pane, limited to the persona's purview.
- **Referrals (real):** "Refer Suzanne Jackson for a HELOC, about $60k, she prefers a call after 5 pm". Then try "make it email instead", Approve, Deny or Return with note. "Refer Maria Gomez for a mortgage" asks how she prefers to be contacted. As Marcus, "Refer Robert Jackson for a mortgage" finds nobody, because Robert banks at Northgate. Elena (bank) has no Referrals app and is told so.
- **Reports (real):** open **Reports** and a standard report, then change Month or Branch. In a conversation: "Open the August branch scorecard for Northgate", "Export it to Excel" (approve, then Download), "Send this report to the ALCO group and All lending staff monthly on the third business day" (high risk: type 38). "Build me a monthly ALCO pack with loan balance trend, deposit mix, certificate share and delinquency ratio", then "Make the deposit mix a bar chart", Revert or Accept, and "Save it in Finance / ALCO".
- **Members (real):** as Marcus, "Pull up Suzanne Jackson at Westport", then "What should I talk to her about?", "Why is her attrition risk medium?", **Refer: Credit card** on the card, and **Member declined** on Checking in the 360's Opportunities tab. "Pull up Jackson" asks which one. "Pull up Robert Jackson" finds nobody for Marcus (Northgate) but works for Dana. Try `4521` or `(555) 015-0461` in **Ctrl+K**.
- **Approvals (scripted):** "Approve October incentive payouts for Westport" shows a high-risk card with typed confirmation. The task shows a hand in the sidebar while it waits for you.
- **Developer persona switch** (user menu, mock only). Dana (executive), Priya (analyst, Query Browser), Marcus (Westport branch manager, Westport purview only), Elena (bank CFO: "customer" wording, no SEG or 5300, late nightly build) and Sam (administrator).
- **Layouts:** resize below 1024 px and 768 px to see the tablet and phone layouts (spec 10.10). F6 cycles regions, and Esc stops a running run.

## Scripts

| Script | What it does |
|---|---|
| `npm run check` | Everything CI should run: token freshness, typecheck, ESLint, stylelint, tests, builds and the bundle budget |
| `npm test` | Vitest: token contrast, schemas, stream ordering, block components with axe, shell components with axe, protocol tests against the mock server |
| `npm run budget` | Fails if the shell's initial JS exceeds 250 KB gzip or a lazy chunk exceeds 350 KB (FE-ARCH-070) |
| `npm run tokens` | Regenerates CSS variables and the TS token module from `packages/tokens/tokens.json` |
| `npm run schemas` | Regenerates JSON Schemas (`packages/block-schemas/json`) from the Zod schemas |
| `npm -w @dinext/shell run preview` | Serves the shell's production build, which carries the spec's Content Security Policy |

## Layout

| Package | Spec | Contents |
|---|---|---|
| `apps/shell` | 6, 8.2–8.4, 10.10, 11 | The DI Next application: session bootstrap, routes, shell regions, Home, threads, conversations list, tables, palette, notifications, idle timeout |
| `apps/gallery` | 11.13 | Block workbench and stream playground |
| `packages/tokens` | 10.2–10.4 | Token source, generated CSS variables (light, dark, compact), WCAG contrast checks |
| `packages/ui` | 10 | Base components, live-region announcer, toasts, preferences, Trusted Types policy |
| `packages/block-schemas` | 9, 12 | Block schemas and validator, stream events, REST shapes shared with the server, fixtures |
| `packages/blocks` | 6.8–6.13, 9, 10.5 | Block renderers (text, kpi, kpi_group, chart, table, list, notice, plan_steps, approval_card, member_card, member_360, report_canvas), the shared frame and the AG Grid host |
| `packages/stream-client` | 11.5–11.6, 12 | Sequence-ordered stream store, WebSocket connection with thread subscriptions, REST client |
| `packages/mock-stream-server` | 11.2, 12 | Experience server: personas, Home, search, notifications, threads, approvals, the live Concierge runtime (`src/live.ts`) and the scripted scenarios |
| `packages/tenant-db` | 15, 17.2 | Warehouse schema, deterministic synthetic data for a credit union and a bank (18 months of history, contact details, digital use, scores, suggestions, loan applications and interactions), seed script |
| `packages/semantic` | 16 | YAML semantic model with tenant overrides, request validation, SQL compiler with purview, catalog search, query service |
| `packages/di-core` | 17.2, 17.3, 19, 25.3 | DI Core stand-in: referral types and forms, routing (by location, queue, round-robin, fallback), idempotent referral create, the approval service, the report store (templates, private drafts, schedules, exports), and Relationship Manager (party search, 360 profile, score explanations, next best conversation, member declined, opaque member tokens) |
| `packages/voice` | 7, 12.7 | Voice gateway, speech provider interface with Azure AI Speech and fake adapters, transcript normalisation, speakable text and read-backs |
| `packages/agents` | 23–26 | Model client and roles, pre-screen, Concierge, Analytics Q&A tool loop, grounding and numeric verification, Briefing, Referral, Relationship and Report Builder agents, member blocks, the report engine, tool gateways, offline planners, audit log |

## Decisions and deviations from the spec

- **Schemas are written in Zod.** The JSON Schemas the spec calls the source of truth (FE-ARCH-002) are generated from them into `packages/block-schemas/json`.
- **Threads rebuild from the stream.** Subscribing to a thread replays its events after the client's last sequence. Reloads, shared links and reconnects therefore all use one path, and the spec's separate thread snapshot endpoint returns metadata only.
- **`GET /v1/home` is an assumption.** The spec describes the briefing (6.3) but lists no endpoint for it.
- **Workbench instead of Storybook for now.** Storybook and Playwright screenshot diffs (11.13) remain to be added.
- **AG Grid Community, static Quartz stylesheet.** AG Grid's JS theming injects `<style>` tags that `style-src 'self'` blocks. Enterprise needs a licence key (spec 11.1).
- **CSP additions and one known gap.** `font-src` allows `data:` for AG Grid's icon font. Trusted Types uses a `default` policy that only lets through empty HTML, and Zod runs `jitless`. Radix dialogs inject a scroll-lock `<style>`, which the static CSP blocks; this is harmless because the shell body never scrolls. The production server should send the CSP as a header with a per-response nonce plus `<meta name="csp-nonce">`, which the client already passes to the style injector.
- **Theme and density stay in this browser** until a preferences endpoint exists (spec 11.5). They hold no institution data. The developer persona switch is also kept there, mock only.
- **Cloud services are not touched yet.** The spec targets AWS (Bedrock, Transcribe, Polly). Later slices put LLM, speech, storage and events behind adapters so the planned Azure move is configuration.
- **Claude through the Anthropic API.** The model client sits behind a `ModelClient` interface, so Bedrock or Azure is a new adapter. Roles and models are set with `DI_MODEL_*`.
- **The warehouse is MySQL 8.4 in Docker** with the spec's CDM table names, a small subset of columns, and month-end history tables. Figures are deterministic, so tests can assert exact values.
- **Ratios, period comparisons and every figure in prose are computed in code**, never by the model (spec 26.7).
- **The mock server package name is kept** (`@dinext/mock-stream-server`) to avoid churn. It now acts as the Experience server.
- **Referral types, queues and routing are seeded configuration** standing in for the Referral Builder Worksheet (spec 17.3). Six types; branch lending and member-services queues round-robin among that branch's staff; mortgage and business go to shared queues that members claim.
- **"Edit plan" asks for the change in chat.** The spec's "Edit first" opens the draft in the classic form (AI-GRD-074); there is no form block yet, so the user says what to change and gets a new card.
- **The recipient within a queue is fixed at creation.** The card shows the queue that was approved and who is next in rotation; if someone else's referral takes that turn first, the next person gets it. The approved queue never changes.
- **Approval state lives in the tenant database** (`ai_approvals`), so it survives a server restart. Thread conversation memory is still in-process.
- **Azure AI Speech instead of Amazon Transcribe and Polly** (spec 7.2), because the platform is moving to Azure. Both sit behind one `SpeechProvider` interface, so the gateway and the client do not change. Azure's phrase list stands in for Transcribe's custom vocabulary; a custom speech model (spec 7.8) is a later step.
- **Speech is synthesised a sentence at a time** rather than with word marks. Each sentence's caption shows when its audio starts, so captions stay in step on any provider, and the first audio starts sooner.
- **The Experience server speaks voice-initiated answers itself** from the run's stream: text and notices are spoken, tables and charts are not, and approval cards get their read-back. The spec's separate "speakable" text per block is derived in code from what is on screen, so the two never differ.
- **Reports are a JSON definition, not stored SQL.** Every widget is a semantic query (spec 18.2 prefers this); widgets with SQL for Query Browser users are a later step. Templates, schedules and exports live in the workflow store (`esp_report_*`), which the application account may write.
- **Excel and CSV exports only.** PDF and Word need the rendering service (headless Chromium and Apache POI in spec 18.6); a schedule can name PDF, but its delivery is simulated. Exports are rendered at download time from the approved controls, under the downloader's purview, so a file never holds data its owner cannot see.
- **Scheduled delivery is simulated locally.** "Run now" runs each schedule under its owner's access and records the result; production runs once per recipient under each recipient's purview (BE-RPT-020) and sends a secure link.
- **The report canvas keeps a live copy.** Control changes and canvas edits replace the block on screen without a new turn; the conversation keeps the version the agent showed.
- **The spoken-number picker covers member numbers.** A spoken member number shows the matching members to pick from. An account or loan number still only waits for the user to check it, because account numbers are not searchable yet.
- **Relationship data is generated, not loaded.** Scores, suggestions, applications and interactions come from rules over each member's own accounts and a separate seed, standing in for the predictive models and the landing tables (spec 17.2, CA-29). Names repeat across thousands of synthetic members, which exercises the pick list.
- **Member links use an encrypted token.** The token holds the tenant and the party in one AES block, so it decodes without a lookup table and means nothing in another tenant. `DI_TOKEN_SECRET` sets the key; the local default is fine for development only.
- **Rewards and Lifetime Value are not shown.** Their sources are not stated today [BK p11]; the Rewards tab says so. Lifetime Value depends on Profitability (spec 17.14).
- **Member 360 opens beside the conversation on desktop and laptop only.** On tablets and phones the workspace is a full-screen sheet, so the card's **Open 360** button opens it instead of taking over the conversation.

## Not done yet

- **Agents:** a live golden-question evaluation on Claude (needs your approval), conversation memory beyond the server process, referral inbox, update and "mark sold" (stage changes), and real Goals & Incentives and Retention agents.
- **Reports:** PDF and Word exports, report snapshots ("By Report Date", spec 18.8), Table Summary and Detail report builders with their form block (spec 8.6, 8.7), the template settings form with every builder tab (FE-BLD-001), test mode with a PDF preview, drag-and-drop on the canvas, changing a template other people use (high risk with the users and schedules affected, FE-BLD-005), pinning reports to Home, and real delivery to recipients.
- **Relationship Manager:** issue management ("Log an issue", spec 8.24), undoing a decline within 30 days (BE-RM-003), the classic Relationship Dashboard as a full app page with its left navigation, a call-centre screen pop (AS-090), alert rules and the opportunity threshold as tenant settings, and speaking member data aloud (off by default for branch-floor classes).
- **Workflow:** notifications to the recipient (today only the sender's bell), SLA timers, undo for medium writes (spec 6.11), and second approvers.
- **Home and threads:** pinning with undo, Home edit mode, sharing threads, a plan preview for multi-step writes, and file upload.
- **Blocks:** the remaining catalogue blocks (pivot, form, timeline, map, funnel, lineage_graph, report_canvas, file_drop, sql_view). The form block is next in line, for "Edit first".
- **Voice:** hands-free "Hey DI" with an on-device wake word, dictation into form fields, read-back on any block, voice settings (microphone choice, input test, silence threshold, speech rate control in the UI), voice latency telemetry, and Spanish.
- **Azure, beyond the demo:** Entra ID sign-in with per-user sessions and class-based access (spec 25.5), Key Vault with managed identity for secrets, durable audit storage, Application Insights, more than one replica (conversations move out of server memory), private networking for MySQL, and a GitHub Actions pipeline.
- **Platform:** i18n catalogues, telemetry, virtualised long threads and visual regression tests.
