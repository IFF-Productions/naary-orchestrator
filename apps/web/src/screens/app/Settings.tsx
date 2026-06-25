import { Button, Card, Icon, Select, TextInput } from "../../components";

/* Settings — ported from Naary.dc.html (lines 461–488). Workspace, environments
   and API keys. The DC ships these as stacked cards (no tabs, no toggle
   switches, no standalone secrets section); the masked mono key strings are the
   secrets shown here. */

interface EnvRow {
  name: string;
  meta: string;
  dot: string;
  isDefault?: boolean;
}
const environments: EnvRow[] = [
  {
    name: "Production",
    meta: "28 workflows · live traffic",
    dot: "var(--brand)",
    isDefault: true,
  },
  {
    name: "Staging",
    meta: "9 workflows · test data",
    dot: "var(--state-info)",
  },
];

interface ApiKey {
  name: string;
  masked: string;
  used: string;
}
const apiKeys: ApiKey[] = [
  {
    name: "Production key",
    masked: "nry_live_••••••••••••8f3a",
    used: "used 2m ago",
  },
  {
    name: "CI / staging key",
    masked: "nry_test_••••••••••••2b71",
    used: "used 3d ago",
  },
];

export function Settings() {
  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 920 }}>
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
          Settings
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
          Workspace, environments, API keys and secrets.
        </div>
      </div>

      {/* workspace */}
      <Card pad={false} style={{ padding: 20, marginBottom: 16 }}>
        <CardTitle>Workspace</CardTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <SettingRow
            title="Workspace name"
            hint="Shown across the platform."
            control={
              <TextInput defaultValue="Northwind" style={{ width: 260 }} />
            }
          />
          <SettingRow
            title="Default region"
            hint="Where durable state is checkpointed."
            divided
            control={<Select value="us-east-1" style={{ width: 260 }} />}
          />
        </div>
      </Card>

      {/* environments */}
      <Card pad={false} style={{ padding: 20, marginBottom: 16 }}>
        <CardTitle>Environments</CardTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {environments.map((env) => (
            <div
              key={env.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                border: "1px solid var(--line)",
                borderRadius: 9,
                padding: "11px 13px",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: env.dot,
                  flex: "none",
                }}
              />
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--ink)",
                  }}
                >
                  {env.name}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                >
                  {env.meta}
                </div>
              </div>
              {env.isDefault && (
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: "var(--brand)",
                    background: "var(--brand-soft)",
                    padding: "3px 9px",
                    borderRadius: 20,
                  }}
                >
                  Default
                </span>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* API keys */}
      <Card pad={false} style={{ padding: 20 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
            API keys
          </div>
          <Button variant="secondary" size="sm">
            Create key
          </Button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {apiKeys.map((k) => (
            <div
              key={k.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                border: "1px solid var(--line)",
                borderRadius: 9,
                padding: "12px 13px",
              }}
            >
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 7,
                  background: "var(--card-2)",
                  color: "var(--ink-2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flex: "none",
                }}
              >
                <Icon name="key" size={15} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: "var(--ink)",
                  }}
                >
                  {k.name}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 11, color: "var(--ink-3)" }}
                >
                  {k.masked}
                </div>
              </div>
              <span
                className="mono"
                style={{ fontSize: 10.5, color: "var(--ink-3)" }}
              >
                {k.used}
              </span>
              <Button variant="secondary" size="sm">
                Rotate
              </Button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: 600,
        color: "var(--ink)",
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

function SettingRow({
  title,
  hint,
  control,
  divided,
}: {
  title: string;
  hint: string;
  control: React.ReactNode;
  divided?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        borderTop: divided ? "1px solid var(--line)" : undefined,
        paddingTop: divided ? 14 : undefined,
      }}
    >
      <div>
        <div style={{ fontSize: 12.5, color: "var(--ink)", fontWeight: 500 }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}>
          {hint}
        </div>
      </div>
      {control}
    </div>
  );
}
