import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import type { SignedRequest } from "./auth";

/**
 * SQLite-backed persistence for relay requests.
 * Tracks request lifecycle: received -> submitted -> confirmed/failed.
 */
export interface RelayRecord {
  id: string;
  receivedAt: number;
  status: "pending" | "submitted" | "confirmed" | "failed" | "expired";
  txSignature?: string;
  error?: string;
  pool: string;
  nullifierHash: string;
  fee: number;
  retries: number;
  clientIp: string;
  submittedAt?: number;
  lastValidBlockHeight?: number;
  nextAttemptAt: number;
  updatedAt: number;
}

interface RelayRow {
  id: string;
  received_at: number;
  status: RelayRecord["status"];
  tx_signature: string | null;
  error: string | null;
  pool: string;
  nullifier_hash: string;
  fee: number;
  retries: number;
  client_ip: string;
  request_json: string;
  submitted_at: number | null;
  last_valid_block_height: number | null;
  next_attempt_at: number;
  updated_at: number;
  protocol_fee: number | null;
  relayer_fee: number | null;
}

interface RateLimitSnapshot {
  globalCount: number;
  globalOldest: number | null;
  ipCount: number;
  ipOldest: number | null;
}

interface PendingReservation {
  clientIp: string;
  fee: number;
  nullifierHash: string;
  pool: string;
  receivedAt: number;
  requestJson: string;
}

interface PendingReservationResult {
  allowed: boolean;
  recordId?: string;
  retryAfter?: number;
}

export class RelayStore {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(dbPath: string, now: () => number = Date.now) {
    const resolved = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.now = now;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.createSchema();
  }

  insert(
    record: Omit<
      RelayRecord,
      | "id"
      | "status"
      | "retries"
      | "submittedAt"
      | "lastValidBlockHeight"
      | "nextAttemptAt"
      | "txSignature"
      | "error"
      | "updatedAt"
    >,
    requestJson = "",
  ): string {
    const id = randomUUID();
    const now = this.now();

    try {
      this.db
        .prepare(
          `insert into relay_requests (
            id,
            received_at,
            status,
            tx_signature,
            error,
            pool,
            nullifier_hash,
            fee,
            retries,
            client_ip,
            request_json,
            submitted_at,
            last_valid_block_height,
            next_attempt_at,
            updated_at
          ) values (
            @id,
            @received_at,
            'pending',
            null,
            null,
            @pool,
            @nullifier_hash,
            @fee,
            0,
            @client_ip,
            @request_json,
            null,
            null,
            @next_attempt_at,
            @updated_at
          )`,
        )
        .run({
          id,
          received_at: record.receivedAt,
          pool: record.pool,
          nullifier_hash: record.nullifierHash,
          fee: record.fee,
          client_ip: record.clientIp,
          request_json: requestJson,
          next_attempt_at: record.receivedAt,
          updated_at: now,
        });
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: relay_requests\.nullifier_hash/i.test(error.message)
      ) {
        throw new Error("Nullifier already exists");
      }

      throw error;
    }

    return id;
  }

  reservePending(
    record: PendingReservation,
    limits: {
      globalLimit: number;
      perIpLimit: number;
      windowMs: number;
    },
  ): PendingReservationResult {
    const insertNow = this.now();
    const insertRecord = this.db.prepare(
      `insert into relay_requests (
          id,
          received_at,
          status,
          tx_signature,
          error,
          pool,
          nullifier_hash,
          fee,
          retries,
          client_ip,
          request_json,
          submitted_at,
          last_valid_block_height,
          next_attempt_at,
          updated_at
        ) values (
          @id,
          @received_at,
          'pending',
          null,
          null,
          @pool,
          @nullifier_hash,
          @fee,
          0,
          @client_ip,
          @request_json,
          null,
          null,
          @next_attempt_at,
          @updated_at
        )`,
    );
    const getSnapshot = this.db.prepare(
      `select
          count(*) as global_count,
          min(received_at) as global_oldest,
          sum(case when client_ip = @client_ip then 1 else 0 end) as ip_count,
          min(case when client_ip = @client_ip then received_at end) as ip_oldest
       from relay_requests
       where received_at >= @since`,
    );
    const reserve = this.db.transaction(
      (input: PendingReservation): PendingReservationResult => {
        const since = input.receivedAt - limits.windowMs;
        const snapshot = getSnapshot.get({
          client_ip: input.clientIp,
          since,
        }) as {
          global_count?: number;
          global_oldest?: number | null;
          ip_count?: number;
          ip_oldest?: number | null;
        };

        if (
          (snapshot.ip_count ?? 0) >= limits.perIpLimit &&
          snapshot.ip_oldest !== null &&
          snapshot.ip_oldest !== undefined
        ) {
          return {
            allowed: false,
            retryAfter: Math.max(
              1,
              limits.windowMs - (input.receivedAt - snapshot.ip_oldest),
            ),
          };
        }

        if (
          (snapshot.global_count ?? 0) >= limits.globalLimit &&
          snapshot.global_oldest !== null &&
          snapshot.global_oldest !== undefined
        ) {
          return {
            allowed: false,
            retryAfter: Math.max(
              1,
              limits.windowMs - (input.receivedAt - snapshot.global_oldest),
            ),
          };
        }

        const id = randomUUID();
        try {
          insertRecord.run({
            id,
            received_at: input.receivedAt,
            pool: input.pool,
            nullifier_hash: input.nullifierHash,
            fee: input.fee,
            client_ip: input.clientIp,
            request_json: input.requestJson,
            next_attempt_at: input.receivedAt,
            updated_at: insertNow,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            /UNIQUE constraint failed: relay_requests\.nullifier_hash/i.test(error.message)
          ) {
            throw new Error("Nullifier already exists");
          }

          throw error;
        }

        return {
          allowed: true,
          recordId: id,
        };
      },
    );

    return reserve(record);
  }

  markSubmitted(
    id: string,
    txSignature: string,
    submittedAt: number,
    lastValidBlockHeight: number,
    nextAttemptAt = submittedAt,
  ): void {
    this.db
      .prepare(
        `update relay_requests
         set status = 'submitted',
             tx_signature = @tx_signature,
             error = null,
             submitted_at = @submitted_at,
             last_valid_block_height = @last_valid_block_height,
             next_attempt_at = @next_attempt_at,
             updated_at = @updated_at
         where id = @id`,
      )
      .run({
        id,
        tx_signature: txSignature,
        submitted_at: submittedAt,
        last_valid_block_height: lastValidBlockHeight,
        next_attempt_at: nextAttemptAt,
        updated_at: this.now(),
      });
  }

  markConfirmed(id: string, txSignature?: string, submittedAt?: number): void {
    this.db
      .prepare(
        `update relay_requests
         set status = 'confirmed',
             error = null,
             tx_signature = case when @tx_signature is null then tx_signature else @tx_signature end,
             submitted_at = case when @submitted_at is null then submitted_at else @submitted_at end,
             protocol_fee = case when @protocol_fee is null then protocol_fee else @protocol_fee end,
             relayer_fee = case when @relayer_fee is null then relayer_fee else @relayer_fee end,
             next_attempt_at = @updated_at,
             updated_at = @updated_at
         where id = @id`,
      )
      .run({
        id,
        submitted_at: submittedAt ?? null,
        tx_signature: txSignature ?? null,
        protocol_fee: null,
        relayer_fee: null,
        updated_at: this.now(),
      });
  }

  recordFeeBreakdown(
    id: string,
    protocolFee: number,
    relayerFee: number,
  ): void {
    this.db
      .prepare(
        `update relay_requests
         set protocol_fee = @protocol_fee,
             relayer_fee = @relayer_fee,
             updated_at = @updated_at
         where id = @id`,
      )
      .run({
        id,
        protocol_fee: protocolFee,
        relayer_fee: relayerFee,
        updated_at: this.now(),
      });
  }

  rescheduleSubmitted(id: string, nextAttemptAt: number, error?: string): void {
    this.db
      .prepare(
        `update relay_requests
         set status = 'submitted',
             error = @error,
             next_attempt_at = @next_attempt_at,
             updated_at = @updated_at
         where id = @id`,
      )
      .run({
        id,
        error: error ?? null,
        next_attempt_at: nextAttemptAt,
        updated_at: this.now(),
      });
  }

  markFailed(
    id: string,
    error: string,
    nextAttemptAt?: number,
    finalFailure = false,
    clearSubmission = true,
  ): void {
    this.db
      .prepare(
        `update relay_requests
         set status = @status,
             error = @error,
             tx_signature = case when @clear_submission = 1 then null else tx_signature end,
             submitted_at = case when @clear_submission = 1 then null else submitted_at end,
             last_valid_block_height = case when @clear_submission = 1 then null else last_valid_block_height end,
             retries = retries + 1,
             next_attempt_at = @next_attempt_at,
             updated_at = @updated_at
         where id = @id`,
      )
      .run({
        id,
        status: finalFailure ? "failed" : "pending",
        error,
        clear_submission: clearSubmission ? 1 : 0,
        next_attempt_at: nextAttemptAt ?? this.now(),
        updated_at: this.now(),
      });
  }

  markExpired(id: string, error = "Relay request expired"): void {
    this.db
      .prepare(
        `update relay_requests
         set status = 'expired',
             error = @error,
             next_attempt_at = @updated_at,
             updated_at = @updated_at
         where id = @id`,
      )
      .run({
        id,
        error,
        updated_at: this.now(),
      });
  }

  getPending(now = Date.now()): RelayRecord[] {
    const rows = this.db
      .prepare(
        `select
            id,
            received_at,
            status,
            tx_signature,
            error,
            pool,
            nullifier_hash,
            fee,
            retries,
            client_ip,
            submitted_at,
            last_valid_block_height,
            next_attempt_at,
            updated_at
         from relay_requests
         where status = 'pending' and next_attempt_at <= @now
         order by received_at asc`,
      )
      .all({ now }) as RelayRow[];

    return rows.map((row) => this.toRelayRecord(row));
  }

  getProcessable(now = Date.now()): RelayRecord[] {
    const rows = this.db
      .prepare(
        `select
            id,
            received_at,
            status,
            tx_signature,
            error,
            pool,
            nullifier_hash,
            fee,
            retries,
            client_ip,
            submitted_at,
            last_valid_block_height,
            next_attempt_at,
            updated_at
         from relay_requests
         where status in ('pending', 'submitted') and next_attempt_at <= @now
         order by next_attempt_at asc, received_at asc`,
      )
      .all({ now }) as RelayRow[];

    return rows.map((row) => this.toRelayRecord(row));
  }

  get(id: string): RelayRecord | null {
    const row = this.db
      .prepare(
        `select
            id,
            received_at,
            status,
            tx_signature,
            error,
            pool,
            nullifier_hash,
            fee,
            retries,
            client_ip,
            submitted_at,
            last_valid_block_height,
            next_attempt_at,
            updated_at
         from relay_requests
         where id = @id`,
      )
      .get({ id }) as RelayRow | undefined;

    return row ? this.toRelayRecord(row) : null;
  }

  getByNullifier(nullifierHash: string): RelayRecord | null {
    const row = this.db
      .prepare(
        `select
            id,
            received_at,
            status,
            tx_signature,
            error,
            pool,
            nullifier_hash,
            fee,
            retries,
            client_ip,
            submitted_at,
            last_valid_block_height,
            next_attempt_at,
            updated_at
         from relay_requests
         where nullifier_hash = @nullifier_hash
         limit 1`,
      )
      .get({ nullifier_hash: nullifierHash }) as RelayRow | undefined;

    return row ? this.toRelayRecord(row) : null;
  }

  getSignedRequest(id: string): SignedRequest | null {
    const row = this.db
      .prepare("select request_json from relay_requests where id = @id")
      .get({ id }) as { request_json?: string } | undefined;

    if (!row?.request_json) {
      return null;
    }

    return JSON.parse(row.request_json) as SignedRequest;
  }

  hasNullifier(nullifierHash: string): boolean {
    const row = this.db
      .prepare(
        "select 1 as present from relay_requests where nullifier_hash = @nullifier_hash limit 1",
      )
      .get({ nullifier_hash: nullifierHash }) as { present?: number } | undefined;

    return row?.present === 1;
  }

  getRateLimitSnapshot(ip: string, since: number): RateLimitSnapshot {
    const row = this.db
      .prepare(
        `select
            count(*) as global_count,
            min(received_at) as global_oldest,
            sum(case when client_ip = @client_ip then 1 else 0 end) as ip_count,
            min(case when client_ip = @client_ip then received_at end) as ip_oldest
         from relay_requests
         where received_at >= @since`,
      )
      .get({
        client_ip: ip,
        since,
      }) as {
        global_count?: number;
        global_oldest?: number | null;
        ip_count?: number;
        ip_oldest?: number | null;
      };

    return {
      globalCount: row.global_count ?? 0,
      globalOldest: row.global_oldest ?? null,
      ipCount: row.ip_count ?? 0,
      ipOldest: row.ip_oldest ?? null,
    };
  }

  getStats(since: number): {
    total: number;
    confirmed: number;
    failed: number;
    pending: number;
    protocolFees: number;
    relayerFees: number;
    totalFees: number;
  } {
    const row = this.db
      .prepare(
        `select
            count(*) as total,
            sum(case when status = 'confirmed' then 1 else 0 end) as confirmed,
            sum(case when status = 'failed' then 1 else 0 end) as failed,
            sum(case when status in ('pending', 'submitted') then 1 else 0 end) as pending,
            sum(case when status = 'confirmed' then protocol_fee else 0 end) as protocol_fees,
            sum(case when status = 'confirmed' then relayer_fee else 0 end) as relayer_fees
         from relay_requests
         where received_at >= @since`,
      )
      .get({ since }) as {
        total?: number;
        confirmed?: number;
        failed?: number;
        pending?: number;
        protocol_fees?: number;
        relayer_fees?: number;
      };

    const protocolFees = row.protocol_fees ?? 0;
    const relayerFees = row.relayer_fees ?? 0;
    return {
      total: row.total ?? 0,
      confirmed: row.confirmed ?? 0,
      failed: row.failed ?? 0,
      pending: row.pending ?? 0,
      protocolFees,
      relayerFees,
      totalFees: protocolFees + relayerFees,
    };
  }

  private createSchema(): void {
    this.db.exec(`
      create table if not exists relay_requests (
        id text primary key,
        received_at integer not null,
        status text not null,
        tx_signature text,
        error text,
        pool text not null,
        nullifier_hash text not null unique,
        fee integer not null,
        retries integer not null default 0,
        client_ip text not null default '',
        request_json text not null default '',
        submitted_at integer,
        last_valid_block_height integer,
        next_attempt_at integer not null,
        updated_at integer not null,
        protocol_fee integer not null default 0,
        relayer_fee integer not null default 0
      );
      create index if not exists idx_relay_requests_status_next_attempt
        on relay_requests(status, next_attempt_at);
      create index if not exists idx_relay_requests_received_at
        on relay_requests(received_at);
      create index if not exists idx_relay_requests_client_ip_received_at
        on relay_requests(client_ip, received_at);
    `);

    this.ensureColumn("client_ip", "text not null default ''");
    this.ensureColumn("submitted_at", "integer");
    this.ensureColumn("last_valid_block_height", "integer");
    this.ensureColumn("protocol_fee", "integer not null default 0");
    this.ensureColumn("relayer_fee", "integer not null default 0");
  }

  private toRelayRecord(row: RelayRow): RelayRecord {
    return {
      id: row.id,
      receivedAt: row.received_at,
      status: row.status,
      txSignature: row.tx_signature ?? undefined,
      error: row.error ?? undefined,
      pool: row.pool,
      nullifierHash: row.nullifier_hash,
      fee: row.fee,
      retries: row.retries,
      clientIp: row.client_ip,
      submittedAt: row.submitted_at ?? undefined,
      lastValidBlockHeight: row.last_valid_block_height ?? undefined,
      nextAttemptAt: row.next_attempt_at,
      updatedAt: row.updated_at,
    };
  }

  private ensureColumn(name: string, definition: string): void {
    const columns = this.db
      .prepare("pragma table_info(relay_requests)")
      .all() as Array<{ name: string }>;

    if (columns.some((column) => column.name === name)) {
      return;
    }

    this.db.exec(`alter table relay_requests add column ${name} ${definition}`);
  }
}
