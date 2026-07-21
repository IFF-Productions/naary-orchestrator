import { useState } from "react";
import { Button, Dialog, TextInput } from "../../../components";
import { api } from "../../../lib/api";
import { useWorkspace } from "../../../workspace/WorkspaceProvider";
import { ErrorLine } from "./misc";

/** Attach the ACTIVE workspace (server enforces the §4 owner-authorized invariant). */
export function AttachCurrentWorkspace({
  companyId,
  reload,
}: {
  companyId: string;
  onAttached?: () => void;
  reload: () => Promise<unknown>;
}) {
  const { activeId } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!activeId) return null;
  return (
    <>
      <Button
        variant="secondary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            await api.attachWorkspaceToCompany(companyId, activeId);
            await reload();
          } catch {
            setMsg(
              "Couldn't attach — you must own the active workspace, and it can't already belong to another company.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Attach current workspace
      </Button>
      {msg && <ErrorLine text={msg} />}
    </>
  );
}

export function CreateCompanyDialog({
  open,
  busy,
  name,
  setName,
  onClose,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  name: string;
  setName: (v: string) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a company"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={onCreate}
          >
            Create
          </Button>
        </>
      }
    >
      <TextInput
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Acme Inc."
        autoFocus
      />
    </Dialog>
  );
}
