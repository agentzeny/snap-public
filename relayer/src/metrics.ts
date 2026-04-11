interface Histogram {
  readonly buckets: number[];
  readonly observations: number[];
}

export interface RelayerTotals {
  total: number;
  confirmed: number;
  failed: number;
  pending: number;
  protocolFees: number;
  relayerFees: number;
  totalFees: number;
}

export class RelayerMetrics {
  private readonly proofVerify: Histogram = {
    buckets: [1, 5, Number.POSITIVE_INFINITY],
    observations: [],
  };
  private readonly txConfirm: Histogram = {
    buckets: [1, 5, 15, 30, 60, Number.POSITIVE_INFINITY],
    observations: [],
  };

  recordProofVerify(seconds: number): void {
    this.proofVerify.observations.push(seconds);
  }

  recordTxConfirm(seconds: number): void {
    this.txConfirm.observations.push(seconds);
  }

  render(totals: RelayerTotals, relayerBalanceLamports: number): string {
    return [
      "# HELP snap_relay_requests_total Total relay requests received",
      "# TYPE snap_relay_requests_total counter",
      `snap_relay_requests_total{status="confirmed"} ${totals.confirmed}`,
      `snap_relay_requests_total{status="failed"} ${totals.failed}`,
      `snap_relay_requests_total{status="pending"} ${totals.pending}`,
      "",
      "# HELP snap_relay_fees_total Total fees earned in lamports",
      "# TYPE snap_relay_fees_total counter",
      `snap_relay_fees_total ${totals.totalFees}`,
      `snap_relay_protocol_fees_total ${totals.protocolFees}`,
      `snap_relay_relayer_fees_total ${totals.relayerFees}`,
      "",
      "# HELP snap_relay_proof_verify_seconds Proof verification latency",
      "# TYPE snap_relay_proof_verify_seconds histogram",
      ...this.renderHistogram("snap_relay_proof_verify_seconds", this.proofVerify),
      "",
      "# HELP snap_relay_tx_confirm_seconds Transaction confirmation latency",
      "# TYPE snap_relay_tx_confirm_seconds histogram",
      ...this.renderHistogram("snap_relay_tx_confirm_seconds", this.txConfirm),
      "",
      "# HELP snap_relayer_balance_lamports Current relayer wallet balance",
      "# TYPE snap_relayer_balance_lamports gauge",
      `snap_relayer_balance_lamports ${relayerBalanceLamports}`,
      "",
    ].join("\n");
  }

  private renderHistogram(name: string, histogram: Histogram): string[] {
    const lines: string[] = [];
    let cumulative = 0;

    for (const bucket of histogram.buckets) {
      cumulative += histogram.observations.filter((value) => value <= bucket).length - cumulative;
      lines.push(
        `${name}_bucket{le="${Number.isFinite(bucket) ? bucket.toFixed(1) : "+Inf"}"} ${cumulative}`,
      );
    }

    const sum = histogram.observations.reduce((total, value) => total + value, 0);
    lines.push(`${name}_sum ${sum}`);
    lines.push(`${name}_count ${histogram.observations.length}`);
    return lines;
  }
}
