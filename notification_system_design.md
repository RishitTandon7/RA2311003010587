# Campus Notification System — Design Document

> **Author:** Rishit Tandon  
> **Roll No:** RA2311003010587  
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

The Notification Service exposes a RESTful API for creating, retrieving, and managing campus notifications. All endpoints return JSON and follow standard HTTP semantics.

### 1.2 Resource Model

```
Notification {
  id:          string (UUID v4)
  type:        enum("Placement", "Result", "Event")
  title:       string
  message:     string
  priority:    integer (1–5, derived from type)
  recipientId: string | null  (null = broadcast)
  isRead:      boolean
  createdAt:   ISO-8601 timestamp
  updatedAt:   ISO-8601 timestamp
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

### 1.4 Request / Response Contracts

#### POST `/api/notifications`

**Request:**

```json
{
  "type": "Placement",
  "title": "TCS On-Campus Drive — 3 May 2026",
  "message": "TCS is conducting an on-campus placement drive. Eligible branches: CSE, IT, ECE. Report to Seminar Hall B by 9:00 AM.",
  "recipientId": null
}
```

**Response (201 Created):**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "Placement",
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
| `type` | string | — | Filter by type: `Placement`, `Result`, `Event` |
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

#### GET `/api/notifications/inbox`

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `top` | int | 10 | Number of highest-priority notifications |

**Response (200 OK):**

```json
{
  "inbox": [ /* top-N ScoredNotification objects, sorted by priority then recency */ ],
  "count": 10
}
```

### 1.5 Error Contract

All errors follow a consistent shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "type must be one of: Placement, Result, Event",
    "timestamp": "2026-05-03T03:30:00.000Z"
  }
}
```

| HTTP Status | Code | When |
|-------------|------|------|
| 400 | `VALIDATION_ERROR` | Invalid request body / params |
| 401 | `UNAUTHORIZED` | Missing or invalid Bearer token |
| 404 | `NOT_FOUND` | Notification ID does not exist |
| 500 | `INTERNAL_ERROR` | Unhandled server error |

---

## Stage 2 — Persistent Storage & DB Schema

### 2.1 Database Choice: PostgreSQL

**Why PostgreSQL:**

- **ACID compliance** — critical for notification delivery guarantees
- **Rich indexing** — B-tree, GIN, partial indexes for efficient queries
- **JSON support** — flexible metadata without schema migrations
- **Mature ecosystem** — excellent ORMs (Prisma, TypeORM), replication, and tooling
- **Scalability** — read replicas, partitioning, and logical replication

### 2.2 Schema

```sql
-- Core notifications table
CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type        VARCHAR(20) NOT NULL CHECK (type IN ('Placement', 'Result', 'Event')),
    title       VARCHAR(255) NOT NULL,
    message     TEXT NOT NULL,
    priority    SMALLINT NOT NULL DEFAULT 1,
    recipient_id UUID NULL,            -- NULL = broadcast to all
    is_read     BOOLEAN NOT NULL DEFAULT FALSE,
    is_deleted  BOOLEAN NOT NULL DEFAULT FALSE,  -- soft-delete
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

### 2.3 Priority Derivation

Priority is computed from type at insert time via a trigger:

```sql
CREATE OR REPLACE FUNCTION set_notification_priority()
RETURNS TRIGGER AS $$
BEGIN
    NEW.priority := CASE NEW.type
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

---

## Stage 3 — Query Optimisation & Indexing

### 3.1 Key Access Patterns

| Pattern | Query | Frequency |
|---------|-------|-----------|
| **Inbox** | Top N by priority DESC, created_at DESC | Very high |
| **By type** | WHERE type = ? ORDER BY created_at DESC | High |
| **Unread** | WHERE is_read = FALSE AND recipient_id = ? | Very high |
| **By ID** | WHERE id = ? | Medium |
| **Broadcast check** | WHERE recipient_id IS NULL | Medium |

### 3.2 Index Strategy

```sql
-- Composite index for Priority Inbox queries (covers the hot path)
CREATE INDEX idx_notifications_priority_inbox
    ON notifications (priority DESC, created_at DESC)
    WHERE is_deleted = FALSE;

-- Type-based filtering
CREATE INDEX idx_notifications_type_created
    ON notifications (type, created_at DESC)
    WHERE is_deleted = FALSE;

-- Unread notifications per recipient (most-used query)
CREATE INDEX idx_notifications_unread_recipient
    ON notifications (recipient_id, created_at DESC)
    WHERE is_read = FALSE AND is_deleted = FALSE;

-- Read-tracking lookups
CREATE INDEX idx_notification_reads_user
    ON notification_reads (user_id, read_at DESC);
```

### 3.3 Query Optimisation Techniques

1. **Partial Indexes** — All indexes use `WHERE is_deleted = FALSE` to exclude soft-deleted rows, keeping the index small and fast.

2. **Covering Indexes** — The priority inbox index covers both sort columns, eliminating the need for a post-index sort.

3. **LIMIT pushdown** — The inbox query uses `LIMIT 10`, which PostgreSQL can satisfy by scanning just the first 10 entries of the sorted index without touching the rest.

4. **Prepared Statements** — Parameterised queries avoid repeated planning overhead and prevent SQL injection.

5. **Connection Pooling** — Use PgBouncer or built-in pool (e.g., Prisma's connection pool) to avoid per-request connection overhead.

### 3.4 Example Optimised Inbox Query

```sql
-- Top 10 Priority Inbox — uses idx_notifications_priority_inbox
SELECT id, type, title, message, priority, created_at
FROM notifications
WHERE is_deleted = FALSE
ORDER BY priority DESC, created_at DESC
LIMIT 10;
```

**EXPLAIN ANALYZE** would show an **Index Scan** with no sort node — the index already provides the correct order.

---

## Stage 4 — Performance Improvement (Caching & Beyond)

### 4.1 Multi-Layer Caching Architecture

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌───────────┐
│  Client   │────▶│  CDN /   │────▶│  Redis   │────▶│ PostgreSQL│
│ (Browser) │     │  Edge    │     │  Cache   │     │  (Source)  │
└──────────┘     └──────────┘     └──────────┘     └───────────┘
```

### 4.2 Redis Caching Strategy

| Cache Key Pattern | TTL | Invalidation |
|-------------------|-----|--------------|
| `inbox:{userId}` | 30s | On new notification create |
| `notif:{id}` | 5min | On update/delete |
| `notifs:type:{type}:page:{n}` | 60s | On new notification of that type |
| `unread_count:{userId}` | 15s | On read/create |

### 4.3 Cache-Aside Pattern Implementation

```
GET /api/notifications/inbox
  1. Check Redis: inbox:{userId}
  2. If HIT → return cached data
  3. If MISS → query PostgreSQL
  4. Store result in Redis with 30s TTL
  5. Return data
```

### 4.4 Cache Invalidation Strategy

- **Write-through** for critical data (mark-as-read): Update DB + invalidate cache in the same transaction.
- **Event-driven** for bulk operations: Publish a `notification.created` event → cache invalidation worker clears relevant keys.
- **TTL-based** for less critical data: Allow stale reads for up to 60 seconds on listing pages.

### 4.5 Additional Performance Optimisations

1. **Response Compression** — gzip/brotli on all JSON responses (~70% size reduction).
2. **Pagination Cursors** — Use cursor-based pagination (keyset) instead of OFFSET for deep pages:

   ```sql
   WHERE (priority, created_at, id) < ($1, $2, $3)
   ORDER BY priority DESC, created_at DESC
   LIMIT 20
   ```

3. **Database Connection Pooling** — PgBouncer in transaction mode, pool size 20–50.
4. **Read Replicas** — Route GET requests to replicas; POST/PATCH/DELETE to primary.
5. **HTTP Caching Headers** — `Cache-Control: private, max-age=30` on inbox responses.

---

## Stage 5 — Scalability & Reliability for "Notify All"

### 5.1 The Challenge

A "Notify All" broadcast must deliver a notification to every student on campus (potentially 10,000+ recipients) without:

- Blocking the API response
- Overloading the database with 10K+ inserts
- Losing notifications if a server crashes mid-delivery

### 5.2 Architecture: Async Fan-Out with Message Queue

```
┌──────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│  API      │────▶│  Message     │────▶│  Worker Pool  │────▶│  PostgreSQL  │
│  Server   │     │  Queue       │     │  (consumers)  │     │  + Redis     │
│           │     │  (RabbitMQ   │     │               │     │              │
│           │     │   or SQS)    │     │               │     │              │
└──────────┘     └──────────────┘     └───────────────┘     └──────────────┘
       │                                      │
       │                                      ▼
       │                              ┌──────────────┐
       │                              │  Push / Email │
       │                              │  Service      │
       └─────── 202 Accepted ────────▶│              │
                                      └──────────────┘
```

### 5.3 "Notify All" Flow

1. **API receives** `POST /api/notifications` with `recipientId: null` (broadcast).
2. **Insert one row** into `notifications` table — the canonical notification.
3. **Publish event** `notification.broadcast.created` to the message queue.
4. **Return `202 Accepted`** immediately (non-blocking).
5. **Worker(s) consume** the event:
   - Fetch the recipient list (all active students) in batches of 500.
   - For each batch, bulk-insert rows into `notification_reads` (pre-marked as unread).
   - Push to delivery channels (push notification, email, SMS) via respective services.
   - Acknowledge the message only after successful processing.
6. **Retry on failure** — if a worker crashes, the message remains in the queue and is redelivered to another worker (at-least-once delivery).

### 5.4 Batch Processing Details

```typescript
// Pseudocode for the worker
async function processBroadcast(notificationId: string) {
  const BATCH_SIZE = 500;
  let offset = 0;

  while (true) {
    const recipients = await getActiveStudents(offset, BATCH_SIZE);
    if (recipients.length === 0) break;

    // Bulk insert unread tracking rows
    await bulkInsertNotificationReads(notificationId, recipients);

    // Fan-out to push notification service
    await pushNotificationService.sendBatch(
      recipients.map(r => ({
        userId: r.id,
        notificationId,
        channel: r.preferredChannel
      }))
    );

    offset += BATCH_SIZE;
  }
}
```

### 5.5 Reliability Guarantees

| Concern | Solution |
|---------|----------|
| **Delivery guarantee** | At-least-once via message queue acks |
| **Idempotency** | Unique constraint on `(notification_id, user_id)` in `notification_reads` — duplicate inserts are safely ignored |
| **Backpressure** | Rate-limit workers to N concurrent batches |
| **Monitoring** | Dead-letter queue (DLQ) for permanently failed deliveries; alert on DLQ depth |
| **Data consistency** | The canonical notification is in PostgreSQL; reads/delivery are eventually consistent |

### 5.6 Horizontal Scaling

- **API servers**: Stateless, behind a load balancer — scale horizontally.
- **Workers**: Each worker is independent; add more to increase throughput.
- **Database**: Read replicas for GET queries; primary for writes.
- **Queue**: RabbitMQ cluster or AWS SQS (managed, auto-scaling).

---

## Stage 6 — Priority Inbox Implementation

### 6.1 Algorithm: Min-Heap Based Top-N Selection

The Priority Inbox must return the top 10 most important notifications without fully sorting the dataset.

**Approach:** Maintain a min-heap of size N (10). For each notification:

- Score it based on type (Placement=3, Result=2, Event=1).
- If the heap has fewer than N items, insert.
- If the heap is full and the new item has higher priority than the heap's minimum, evict the minimum and insert the new item.
- Ties on priority are broken by recency (latest timestamp wins).

**Complexity:**

| Metric | Value |
|--------|-------|
| Time | O(n × log N) where n = total, N = inbox size |
| Space | O(N) |
| Comparison | vs. full sort O(n × log n) — significantly better when N ≪ n |

### 6.2 Implementation

The full implementation is in `notification_app_be/index.ts`. Key components:

- **`PriorityInbox` class** — Custom min-heap with configurable capacity.
- **`getPriorityWeight()`** — Maps notification type to numeric score.
- **`getTopNotifications()`** — Orchestrates scoring and heap selection.
- **Logging** — Every step is logged via `Log()` with descriptive messages including counts, IDs, and types.

### 6.3 Sample Output

```
#1  | ID=42 | Type=Placement (priority=3) | Time=2026-05-02T10:00:00Z | Message="Google on-campus drive..."
#2  | ID=87 | Type=Placement (priority=3) | Time=2026-05-02T09:30:00Z | Message="Amazon placement results..."
#3  | ID=15 | Type=Result     (priority=2) | Time=2026-05-02T10:15:00Z | Message="Semester 6 results declared..."
...
#10 | ID=3  | Type=Event      (priority=1) | Time=2026-05-01T14:00:00Z | Message="Annual hackathon registration..."
```

---

## Appendix — Technology Stack Summary

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Language | TypeScript (Node.js) | Type safety, modern async/await |
| Database | PostgreSQL | ACID, rich indexing, JSON support |
| Cache | Redis | Sub-ms reads, pub/sub for invalidation |
| Queue | RabbitMQ / AWS SQS | Reliable async fan-out |
| API Framework | Express.js | Lightweight, well-documented |
| ORM | Prisma | Type-safe queries, migrations |
| Logging | Custom `Log()` middleware | Centralised, validated, API-backed |
