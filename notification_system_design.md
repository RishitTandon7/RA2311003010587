# Campus Notification System — Design Document

> **Scope:** Backend design for a campus notification platform serving real-time updates on Placements, Events, and Results.

---

## Table of Contents

1. [Stage 1 — REST API Design & Contract](#stage-1--rest-api-design--contract)
2. [Stage 2 — Persistent Storage & DB Schema](#stage-2--persistent-storage--db-schema)
3. [Stage 3 — Query Optimisation & Indexing](#stage-3--query-optimisation--indexing)
4. [Stage 4 — Performance Improvement (Caching & Beyond)](#stage-4--performance-improvement-caching--beyond)
5. [Stage 5 — Scalability & Reliability for "Notify All"](#stage-5--scalability--reliability-for-notify-all)
6. [Stage 6 — Priority Inbox Implementation](#stage-6--priority-inbox-implementation)

---

## Stage 1 — REST API Design & Contract

### 1.1 Overview

The Notification Service exposes a RESTful API for creating, retrieving, updating, and managing campus notifications. All endpoints return JSON and follow standard HTTP semantics. Authentication uses Bearer tokens.

### 1.2 Resource Model

```
Notification {
  id:               string (UUID v4)
  notificationType: enum("Placement", "Result", "Event")
  title:            string
  message:          string
  priority:         integer (derived: Placement=3, Result=2, Event=1)
  recipientId:      string | null  (null = broadcast)
  isRead:           boolean
  createdAt:        ISO-8601 timestamp
  updatedAt:        ISO-8601 timestamp
}
```

### 1.3 Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/notifications` | Create a new notification | Bearer |
| `GET` | `/api/notifications` | List notifications (paginated, filtered) | Bearer |
| `GET` | `/api/notifications/:id` | Get a single notification by ID | Bearer |
| `PATCH` | `/api/notifications/:id/read` | Mark a notification as read | Bearer |
| `DELETE` | `/api/notifications/:id` | Soft-delete a notification | Bearer |
| `GET` | `/api/notifications/inbox` | Priority Inbox — top N by priority + recency | Bearer |
| `POST` | `/api/notifications/broadcast` | "Notify All" — send to all students | Bearer |

### 1.4 Request / Response Contracts

#### POST `/api/notifications`

**Request:**

```json
{
  "notificationType": "Placement",
  "title": "TCS On-Campus Drive — 3 May 2026",
  "message": "TCS is conducting an on-campus placement drive. Eligible branches: CSE, IT, ECE. Report to Seminar Hall B by 9:00 AM.",
  "recipientId": null
}
```

**Response (201 Created):**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "notificationType": "Placement",
  "title": "TCS On-Campus Drive — 3 May 2026",
  "message": "TCS is conducting an on-campus placement drive...",
  "priority": 3,
  "recipientId": null,
  "isRead": false,
  "createdAt": "2026-05-03T03:30:00.000Z",
  "updatedAt": "2026-05-03T03:30:00.000Z"
}
```

#### GET `/api/notifications`

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | int | 1 | Page number |
| `limit` | int | 20 | Items per page (max 100) |
| `notificationType` | string | — | Filter: `Placement`, `Result`, `Event` |
| `isRead` | boolean | — | Filter by read status |
| `sortBy` | string | `createdAt` | Sort field |
| `order` | string | `desc` | `asc` or `desc` |

**Response (200 OK):**

```json
{
  "data": [ /* array of Notification objects */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 148,
    "totalPages": 8
  }
}
```

#### GET `/api/notifications/:id`

**Response (200 OK):**

```json
{
  "id": "a1b2c3d4...",
  "notificationType": "Result",
  "title": "Semester 6 Results Declared",
  "message": "Check the portal for your grades.",
  "priority": 2,
  "isRead": false,
  "createdAt": "2026-05-02T10:00:00.000Z"
}
```

#### PATCH `/api/notifications/:id/read`

**Response (200 OK):**

```json
{
  "id": "a1b2c3d4...",
  "isRead": true,
  "updatedAt": "2026-05-03T04:00:00.000Z"
}
```

#### GET `/api/notifications/inbox`

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `top` | int | 10 | Number of highest-priority notifications |

**Response (200 OK):**

```json
{
  "inbox": [ /* top-N ScoredNotification objects */ ],
  "count": 10
}
```

### 1.5 Real-Time Mechanism: Server-Sent Events (SSE)

**Choice: SSE** over WebSocket and polling.

**Justification:**

| Approach | Pros | Cons |
|----------|------|------|
| **SSE** ✅ | Unidirectional (perfect for notifications), auto-reconnect built into the browser, works over HTTP/2, simpler than WebSocket | No client → server messaging (not needed here) |
| WebSocket | Bidirectional | Overkill for one-way push, more complex server infrastructure |
| Polling | Simple to implement | Wastes bandwidth, high latency between polls |

Since notifications flow server → client only, SSE is the optimal choice.

**Connection Flow:**

```
1. Client opens:  GET /api/notifications/stream (Accept: text/event-stream)
2. Server holds the connection open
3. On new notification: server pushes `data: { ... }\n\n`
4. On disconnect: browser auto-reconnects with Last-Event-ID header
5. Server replays missed events since Last-Event-ID
```

### 1.6 Error Contract

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "notificationType must be one of: Placement, Result, Event",
    "timestamp": "2026-05-03T03:30:00.000Z"
  }
}
```

| HTTP Status | Code | When |
|-------------|------|------|
| 400 | `VALIDATION_ERROR` | Invalid request body / params |
| 401 | `UNAUTHORIZED` | Missing or invalid Bearer token |
| 404 | `NOT_FOUND` | Notification ID does not exist |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unhandled server error |

---

## Stage 2 — Persistent Storage & DB Schema

### 2.1 Database Choice: PostgreSQL

**Why PostgreSQL:**

- **ACID compliance** — critical for notification delivery guarantees; a student must never miss a placement notification due to a partial write.
- **Rich indexing** — B-tree, partial indexes, composite indexes for efficient priority queries.
- **Enum support** — native `ENUM` type for `notificationType`.
- **Mature ecosystem** — excellent ORMs (Prisma, TypeORM), replication, tooling.
- **Scalability** — read replicas, table partitioning, logical replication.

### 2.2 Schema

```sql
-- Enum for notification types
CREATE TYPE notification_type AS ENUM ('Placement', 'Result', 'Event');

-- Core notifications table
CREATE TABLE notifications (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_type notification_type NOT NULL,
    title             VARCHAR(255) NOT NULL,
    message           TEXT NOT NULL,
    priority          SMALLINT NOT NULL DEFAULT 1,
    recipient_id      UUID NULL,            -- NULL = broadcast to all
    is_read           BOOLEAN NOT NULL DEFAULT FALSE,
    is_deleted        BOOLEAN NOT NULL DEFAULT FALSE,  -- soft-delete
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user read tracking (for broadcast notifications)
CREATE TABLE notification_reads (
    notification_id UUID NOT NULL REFERENCES notifications(id),
    user_id         UUID NOT NULL,
    read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (notification_id, user_id)
);

-- Audit trail for delivery attempts
CREATE TABLE notification_delivery_log (
    id              BIGSERIAL PRIMARY KEY,
    notification_id UUID NOT NULL REFERENCES notifications(id),
    channel         VARCHAR(20) NOT NULL, -- 'push', 'email', 'sms'
    status          VARCHAR(20) NOT NULL, -- 'pending', 'sent', 'failed'
    attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    error_detail    TEXT
);
```

### 2.3 Priority Derivation Trigger

```sql
CREATE OR REPLACE FUNCTION set_notification_priority()
RETURNS TRIGGER AS $$
BEGIN
    NEW.priority := CASE NEW.notification_type
        WHEN 'Placement' THEN 3
        WHEN 'Result'    THEN 2
        WHEN 'Event'     THEN 1
        ELSE 0
    END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_priority
    BEFORE INSERT OR UPDATE ON notifications
    FOR EACH ROW EXECUTE FUNCTION set_notification_priority();
```

### 2.4 Scaling Problems & Solutions

| # | Problem | Solution |
|---|---------|----------|
| 1 | **Table bloat** — millions of old notifications slow down queries | **Time-based partitioning** — partition `notifications` by `created_at` (monthly). Old partitions can be detached/archived without affecting live queries. |
| 2 | **Read tracking explosion** — a broadcast to 50K students creates 50K rows in `notification_reads` | **Lazy read tracking** — only insert into `notification_reads` when a student actually reads the notification, not at send time. Use a "last seen" watermark per user. |
| 3 | **Write contention** — high burst of notifications (e.g. placement season) causes lock contention | **Write-ahead buffering** — batch inserts via a message queue; workers bulk-insert in batches of 500, reducing per-row transaction overhead. |

### 2.5 Queries Matching Stage 1 APIs

**Query 1: List notifications (paginated)**
```sql
SELECT id, notification_type, title, message, priority, is_read, created_at
FROM notifications
WHERE is_deleted = FALSE
  AND (recipient_id = $1 OR recipient_id IS NULL)
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;
```

**Query 2: Priority Inbox (top 10)**
```sql
SELECT id, notification_type, title, message, priority, created_at
FROM notifications
WHERE is_deleted = FALSE
ORDER BY priority DESC, created_at DESC
LIMIT 10;
```

**Query 3: Unread count for a user**
```sql
SELECT COUNT(*)
FROM notifications n
WHERE n.is_deleted = FALSE
  AND n.is_read = FALSE
  AND (n.recipient_id = $1 OR n.recipient_id IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM notification_reads nr
    WHERE nr.notification_id = n.id AND nr.user_id = $1
  );
```

---

## Stage 3 — Query Optimisation & Indexing

### 3.1 Analysing the Slow Query

Consider the following poorly-performing query:

```sql
-- SLOW QUERY (given)
SELECT *
FROM notifications
WHERE notification_type = 'Placement'
ORDER BY created_at DESC;
```

**Why is this query slow?**

1. **`SELECT *` fetches all columns** — includes `message` (TEXT) which can be very large. This forces PostgreSQL to read full rows from the heap instead of serving the query from an index alone. If we only need `id`, `title`, `created_at`, we are wasting I/O.

2. **Missing composite index** — without an index on `(notification_type, created_at DESC)`, PostgreSQL must do a **sequential scan** of the entire table, then sort all matching rows by `created_at`. For millions of rows, this is extremely expensive.

3. **No `LIMIT`** — the query returns *every* Placement notification ever created. If there are 100,000 Placement notifications, all 100K rows are loaded into memory, sorted, and transmitted.

4. **No filter on `is_deleted`** — includes soft-deleted rows that should be excluded.

### 3.2 Optimised Version

```sql
-- OPTIMISED QUERY
SELECT id, notification_type, title, priority, created_at
FROM notifications
WHERE notification_type = 'Placement'
  AND is_deleted = FALSE
ORDER BY created_at DESC
LIMIT 20;
```

**Improvements:**
- Explicit column list instead of `SELECT *`
- `is_deleted = FALSE` filter excludes dead rows
- `LIMIT 20` caps the result set
- Supported by the index below

### 3.3 Should We "Index Every Column"?

**No.** A junior developer suggesting "just index every column" is **wrong** because:

1. **Write penalty** — every INSERT and UPDATE must maintain *all* indexes. With 10+ indexes, write performance can degrade by 5–10×.
2. **Storage cost** — each index consumes disk space proportional to the table size. Redundant indexes waste gigabytes.
3. **Planner confusion** — too many indexes can cause the query planner to choose a suboptimal plan.
4. **Maintenance overhead** — `VACUUM` and `REINDEX` take longer with more indexes.

**The correct approach:** Index only the columns and combinations that appear in frequent `WHERE`, `ORDER BY`, and `JOIN` clauses. Use `EXPLAIN ANALYZE` to validate.

### 3.4 Optimised Query: Placement Notifications in the Last 7 Days

```sql
SELECT id, notification_type, title, message, priority, created_at
FROM notifications
WHERE notification_type = 'Placement'
  AND created_at >= NOW() - INTERVAL '7 days'
  AND is_deleted = FALSE
ORDER BY created_at DESC
LIMIT 50;
```

### 3.5 Index Strategy

```sql
-- Composite index for Priority Inbox queries (covers the hot path)
CREATE INDEX idx_notifications_priority_inbox
    ON notifications (priority DESC, created_at DESC)
    WHERE is_deleted = FALSE;

-- Type + date filtering (used by the optimised query above)
CREATE INDEX idx_notifications_type_created
    ON notifications (notification_type, created_at DESC)
    WHERE is_deleted = FALSE;

-- Unread notifications per recipient (most-used query)
CREATE INDEX idx_notifications_unread_recipient
    ON notifications (recipient_id, created_at DESC)
    WHERE is_read = FALSE AND is_deleted = FALSE;

-- Read-tracking lookups
CREATE INDEX idx_notification_reads_user
    ON notification_reads (user_id, read_at DESC);
```

**Key techniques used:**

1. **Partial Indexes** — all indexes use `WHERE is_deleted = FALSE` to exclude soft-deleted rows, keeping the index small.
2. **Covering Indexes** — the priority inbox index covers both sort columns, eliminating post-index sorts.
3. **LIMIT pushdown** — PostgreSQL satisfies `LIMIT 10` by scanning just 10 index entries.
4. **Prepared Statements** — parameterised queries avoid re-planning overhead.

---

## Stage 4 — Performance Improvement (Caching & Beyond)

### 4.1 Root Cause of DB Overload

When thousands of students simultaneously check their notifications (e.g. during placement season), the database becomes the bottleneck because:

- Every request triggers a `SELECT ... ORDER BY priority DESC, created_at DESC LIMIT 10` query
- Even with indexes, the connection pool saturates under 5,000+ concurrent requests
- The DB spends CPU on planning + execution for queries that return nearly identical results

### 4.2 Strategy 1: Redis Caching (Cache-Aside)

```
Request → Check Redis → HIT → return cached
                      → MISS → query PostgreSQL → store in Redis → return
```

| Cache Key | TTL | Invalidation |
|-----------|-----|--------------|
| `inbox:{userId}` | 30s | On new notification create |
| `notif:{id}` | 5min | On update/delete |
| `notifs:type:{type}:page:{n}` | 60s | On new notification of that type |

**Benefits:** Sub-millisecond reads, 95%+ cache hit rate during peak.

**Trade-offs:**
- **Stale data** — students may see a notification 30s late during cache TTL window.
- **Memory cost** — Redis requires dedicated infrastructure; at scale, sharding may be needed.
- **Cache stampede** — if cache expires during peak, hundreds of requests simultaneously hit the DB. Mitigate with probabilistic early expiry or distributed locks.

### 4.3 Strategy 2: Read Replicas

Route all GET requests to PostgreSQL read replicas; POST/PATCH/DELETE to primary.

**Benefits:** Horizontally scale read capacity independently.

**Trade-offs:**
- **Replication lag** — a student may create a notification and not see it for 100–500ms if their next GET hits a lagging replica. Mitigate with "read-your-own-writes" by routing the creating user's subsequent reads to the primary briefly.
- **Operational complexity** — managing multiple DB instances, monitoring lag.

### 4.4 Strategy 3: Response Compression + HTTP Caching

- gzip/brotli on all JSON responses (~70% size reduction)
- `Cache-Control: private, max-age=30` on inbox responses
- Cursor-based pagination instead of OFFSET for deep pages:

```sql
WHERE (priority, created_at, id) < ($1, $2, $3)
ORDER BY priority DESC, created_at DESC
LIMIT 20
```

**Benefits:** Reduces bandwidth by 70%, eliminates redundant fetches.

**Trade-offs:**
- Cursor pagination is harder to implement than OFFSET pagination.
- HTTP caching doesn't help for unique-per-user data without `Vary` headers.

---

## Stage 5 — Scalability & Reliability for "Notify All"

### 5.1 The Synchronous Loop Problem

Consider this naive implementation:

```javascript
// PROBLEMATIC SYNCHRONOUS APPROACH
async function notifyAll(notification) {
  const students = await db.getAllStudents(); // 50,000 rows
  for (const student of students) {
    await db.insertNotification(notification, student.id);
    await emailService.send(student.email, notification);
  }
  return { status: 200, message: "All notified" };
}
```

**Shortcomings:**

1. **Timeout** — iterating 50,000 students sequentially takes minutes. The HTTP request will timeout long before completion.

2. **Partial failure at index 30,000** — if the loop crashes at student #30,000, the first 30,000 students received the notification but the remaining 20,000 did not. There is no way to resume from where it left off. Re-running would duplicate notifications for the first 30,000.

3. **DB + email coupling** — each iteration does one DB insert AND one email send synchronously. If the email service is slow (500ms/email), the total time is 50,000 × 500ms = ~7 hours. Meanwhile, the DB connection is held open the entire time.

4. **No backpressure** — if the email service rate-limits you, the loop has no retry logic and will throw an error mid-way.

5. **Single point of failure** — if the server restarts, all progress is lost.

### 5.2 Should DB Insert and Email Be Coupled?

**No.** They should be decoupled because:

- DB insert is fast (~1ms) and reliable; email delivery is slow (~500ms) and unreliable.
- Coupling means a temporary email outage blocks all notification persistence.
- They have different failure modes and retry strategies.

**The correct approach:** Insert into DB first (fast, reliable), then publish an event to a message queue for email delivery (async, retryable).

### 5.3 Async Redesign: Fan-Out with Message Queue

```
┌──────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│  API      │────▶│  Message     │────▶│  Worker Pool  │────▶│  PostgreSQL  │
│  Server   │     │  Queue       │     │  (consumers)  │     │  + Redis     │
│           │     │  (RabbitMQ)  │     │               │     │              │
└──────────┘     └──────────────┘     └───────────────┘     └──────────────┘
       │                                      │
       │                                      ▼
       │                              ┌──────────────┐
       └─── 202 Accepted ───────────▶│  Email / Push │
                                      │  Service      │
                                      └──────────────┘
```

### 5.4 Revised Pseudocode

```typescript
// API handler — returns immediately
async function notifyAll(notification: Notification) {
  // 1. Insert one canonical notification row (fast)
  const savedNotif = await db.insertNotification(notification);

  // 2. Publish async job to message queue (fast)
  await messageQueue.publish("notification.broadcast", {
    notificationId: savedNotif.id,
    type: notification.notificationType,
  });

  // 3. Return 202 Accepted immediately (non-blocking)
  return { status: 202, message: "Broadcast queued for delivery" };
}

// Worker — processes batches asynchronously
async function processBroadcast(job: { notificationId: string }) {
  const BATCH_SIZE = 500;
  let cursor = null;

  while (true) {
    // Fetch students in batches using cursor pagination
    const { students, nextCursor } = await db.getActiveStudents({
      limit: BATCH_SIZE,
      cursor,
    });

    if (students.length === 0) break;

    // Bulk insert read-tracking rows (idempotent via UNIQUE constraint)
    await db.bulkInsertNotificationReads(job.notificationId, students);

    // Publish individual email jobs (separate queue for retries)
    for (const student of students) {
      await emailQueue.publish("email.send", {
        to: student.email,
        notificationId: job.notificationId,
      });
    }

    cursor = nextCursor;
  }

  // Acknowledge the message (remove from queue)
  await job.ack();
}
```

### 5.5 Reliability Guarantees

| Concern | Solution |
|---------|----------|
| **Delivery guarantee** | At-least-once via message queue acknowledgement — message stays in queue until worker acks |
| **Idempotency** | `UNIQUE (notification_id, user_id)` on `notification_reads` — duplicate inserts are `ON CONFLICT DO NOTHING` |
| **Partial failure resume** | Cursor-based batching — if worker crashes at batch 60/100, the unacked message is redelivered and processing resumes from batch 60 |
| **Backpressure** | Rate-limit workers to N concurrent batches; email queue has its own rate limiter |
| **Dead letters** | Failed messages after 3 retries go to a Dead-Letter Queue (DLQ); ops team is alerted on DLQ depth |
| **Monitoring** | Track: queue depth, worker throughput, email bounce rate, DLQ size |

---

## Stage 6 — Priority Inbox Implementation

### 6.1 Algorithm: Min-Heap Based Top-N Selection

The Priority Inbox must return the top 10 most important notifications without fully sorting the dataset.

**Approach:** Maintain a min-heap of size N (10). For each notification:

- Score it based on type: Placement=3, Result=2, Event=1.
- Call `add(notification)`:
  - If heap has fewer than N items, insert.
  - If heap is full and new item has higher priority than the heap minimum, evict the minimum and insert.
- Ties on priority are broken by recency (latest timestamp wins).
- Call `getTop()` to extract the final sorted top-N list.

**Complexity:**

| Metric | Value |
|--------|-------|
| Time | O(n × log N) where n = total, N = inbox size |
| Space | O(N) |
| vs. Full Sort | O(n log n) — PriorityInbox is asymptotically better when N ≪ n |

### 6.2 Implementation

The full working implementation is in `notification_app_be/index.ts`. Key components:

- **`PriorityInbox` class** — Custom min-heap with configurable `maxSize` (default 10).
- **`add(notification)`** — Inserts or evicts; never calls `.sort()` on the full array.
- **`getTop()`** — Drains the heap into a sorted array (highest priority first).
- **`getPriorityWeight()`** — Maps notification type to numeric score.
- **Logging** — `Log()` is called inside `add()` on evictions, after fetching, after sorting, and in error handlers.

### 6.3 Expected Output Format

```
#1  [Placement] Google on-campus drive...              2026-05-02T10:00:00Z
#2  [Placement] Amazon placement results...            2026-05-02T09:30:00Z
#3  [Result]    Semester 6 results declared...          2026-05-02T10:15:00Z
#4  [Result]    Lab exam marks uploaded...              2026-05-02T08:00:00Z
...
#10 [Event]     Annual hackathon registration...        2026-05-01T14:00:00Z
```

All Placement notifications appear first (sorted by latest timestamp), then all Result, then all Event.
