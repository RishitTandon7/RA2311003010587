# RA2311003010587 — Backend Evaluation

## Project Structure

```
RA2311003010587/
├── .env                              # Bearer token (never committed)
├── .gitignore
├── tsconfig.json
├── package.json
├── logging_middleware/
│   └── index.ts                      # Phase 1: Reusable Log() middleware
├── vehicle_maintenance_scheduler/
│   └── index.ts                      # Phase 2: 0/1 Knapsack DP scheduler
├── notification_app_be/
│   └── index.ts                      # Phase 3 Stage 6: Priority Inbox
└── notification_system_design.md     # Phase 3 Stages 1–5: System design
```

## Setup

```bash
npm install
```

Set your Bearer token in `.env`:

```
ACCESS_TOKEN=your_token_here
```

## Run

```bash
# Phase 1 — Logging middleware self-test
npm run logging

# Phase 2 — Vehicle Maintenance Scheduler (Knapsack)
npm run scheduler

# Phase 3 — Notification Priority Inbox
npm run notifications

# Run all phases sequentially
npm run all
```

## Phases

| Phase | Deliverable | Description |
|-------|-------------|-------------|
| 1 | `logging_middleware/index.ts` | Reusable `Log()` function with validation + API POST |
| 2 | `vehicle_maintenance_scheduler/index.ts` | 0/1 Knapsack DP per depot — maximise impact within budget |
| 3 (Stages 1–5) | `notification_system_design.md` | API design, DB schema, indexing, caching, scalability |
| 3 (Stage 6) | `notification_app_be/index.ts` | Priority Inbox — efficient top-10 via min-heap |
