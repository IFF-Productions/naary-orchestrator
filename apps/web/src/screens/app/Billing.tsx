import { Button, Card, ProgressBar, Table } from "../../components";

/* Billing & usage — ported from Naary.dc.html (lines 407–437). Plan, spend
   cap and invoices. The DC subtitle mentions "usage by model" but the design
   block ships no such section, so none is rendered here. */

const plan = {
  name: "Scale",
  meta: "$499/mo · billed monthly · renews May 1",
  includedRuns: "100k / mo",
  seats: "12 / 25",
  overage: "$4 / 1k",
};

const spendCap = {
  used: "$1,284",
  cap: "$3,000",
  pct: 43,
  note: "43% used · projected $2,470 by May 1",
};

interface Invoice {
  period: string;
  amount: string;
  status: string;
}
const invoices: Invoice[] = [
  { period: "March 2026", amount: "$2,704.00", status: "Paid" },
  { period: "February 2026", amount: "$2,512.00", status: "Paid" },
  { period: "January 2026", amount: "$2,488.00", status: "Paid" },
];

export function Billing() {
  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 1080 }}>
      {/* heading */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 21,
            fontWeight: 700,
            color: "var(--ink)",
            letterSpacing: "-0.01em",
          }}
        >
          Billing &amp; usage
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
          Plan, spend caps, invoices and usage by model.
        </div>
      </div>

      {/* plan + spend cap */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.3fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        {/* current plan */}
        <Card
          pad={false}
          style={{ padding: 20, position: "relative", overflow: "hidden" }}
        >
          <div
            style={{
              position: "absolute",
              top: -30,
              right: -30,
              width: 140,
              height: 140,
              borderRadius: "50%",
              background:
                "radial-gradient(circle, rgba(242,98,46,.16), transparent 70%)",
            }}
          />
          <div
            className="mono"
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.1em",
              color: "var(--brand)",
              textTransform: "uppercase",
            }}
          >
            Current plan
          </div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: "var(--ink)",
              marginTop: 8,
            }}
          >
            {plan.name}
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 3 }}>
            {plan.meta}
          </div>
          <div style={{ display: "flex", gap: 24, marginTop: 18 }}>
            <PlanStat label="Included runs" value={plan.includedRuns} />
            <PlanStat label="Seats" value={plan.seats} />
            <PlanStat label="Overage" value={plan.overage} />
          </div>
          <Button variant="secondary" style={{ marginTop: 18 }}>
            Manage plan
          </Button>
        </Card>

        {/* spend cap */}
        <Card pad={false} style={{ padding: 20 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
              marginBottom: 4,
            }}
          >
            Spend cap
          </div>
          <div
            style={{ fontSize: 11.5, color: "var(--ink-3)", marginBottom: 16 }}
          >
            Runs pause automatically at the cap.
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 12,
              marginBottom: 7,
            }}
          >
            <span style={{ color: "var(--ink-2)" }}>Used this month</span>
            <span className="mono" style={{ color: "var(--ink)" }}>
              {spendCap.used} / {spendCap.cap}
            </span>
          </div>
          <ProgressBar
            value={spendCap.pct}
            color="linear-gradient(90deg,var(--brand-2),var(--brand))"
          />
          <div
            className="mono"
            style={{ marginTop: 8, fontSize: 10.5, color: "var(--ink-3)" }}
          >
            {spendCap.note}
          </div>
          {/* payment method */}
          <div
            style={{
              marginTop: 16,
              paddingTop: 15,
              borderTop: "1px solid var(--line)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span
              className="mono"
              style={{
                width: 36,
                height: 24,
                borderRadius: 5,
                background: "var(--card-2)",
                border: "1px solid var(--line)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 9,
                fontWeight: 700,
                color: "var(--ink-2)",
              }}
            >
              VISA
            </span>
            <span
              className="mono"
              style={{ fontSize: 12, color: "var(--ink-2)" }}
            >
              •••• 4242
            </span>
            <button
              style={{
                marginLeft: "auto",
                fontSize: 11.5,
                color: "var(--brand)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Update
            </button>
          </div>
        </Card>
      </div>

      {/* invoices */}
      <Card pad={false} style={{ overflow: "hidden" }}>
        <div
          style={{
            padding: "15px 18px 11px",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ink)",
          }}
        >
          Invoices
        </div>
        <Table<Invoice>
          rowKey={(r) => r.period}
          columns={[
            {
              key: "period",
              header: "Period",
              width: "calc((100% - 80px) / 3)",
              render: (r) => (
                <span style={{ color: "var(--ink)" }}>{r.period}</span>
              ),
            },
            {
              key: "amount",
              header: "Amount",
              width: "calc((100% - 80px) / 3)",
              render: (r) => (
                <span className="mono" style={{ color: "var(--ink-2)" }}>
                  {r.amount}
                </span>
              ),
            },
            {
              key: "status",
              header: "Status",
              width: "calc((100% - 80px) / 3)",
              render: (r) => (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--state-done)",
                    background:
                      "color-mix(in srgb, var(--state-done) 14%, transparent)",
                    padding: "3px 10px",
                    borderRadius: 20,
                  }}
                >
                  {r.status}
                </span>
              ),
            },
            {
              key: "pdf",
              header: "",
              width: 80,
              render: () => (
                <button
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--brand)",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  PDF
                </button>
              ),
            },
          ]}
          rows={invoices}
        />
      </Card>
    </div>
  );
}

function PlanStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{label}</div>
      <div
        className="mono"
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: "var(--ink)",
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}
