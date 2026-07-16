import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "./forms";
import {
  Dialog,
  Drawer,
  EmptyState,
  Skeleton,
  Toast,
  Tooltip,
} from "./feedback";

const meta: Meta = { title: "Feedback" };
export default meta;
type Story = StoryObj;

export const Empty: Story = {
  render: () => (
    <EmptyState
      icon="workflow"
      title="No workflows yet"
      body="Create your first automation from the canvas or import one from a cURL command."
      action={
        <Button variant="primary" icon="plus">
          New workflow
        </Button>
      }
    />
  ),
};

export const Skeletons: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 10, maxWidth: 320 }}>
      <Skeleton width={72} height={20} radius={10} />
      <Skeleton width="70%" />
      <Skeleton width="45%" />
    </div>
  ),
};

export const TooltipDemo: Story = {
  render: () => (
    <div style={{ padding: 40 }}>
      <Tooltip label="Archive — hide from this list">
        <Button icon="archive" iconOnly aria-label="Archive" />
      </Tooltip>
    </div>
  ),
};

export const Toasts: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 10, maxWidth: 380 }}>
      <Toast kind="info">Run started — streaming output…</Toast>
      <Toast kind="done" onDismiss={() => {}}>
        Workflow saved.
      </Toast>
      <Toast kind="error" onDismiss={() => {}}>
        Could not reach the control plane.
      </Toast>
    </div>
  ),
};

function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open dialog</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Delete workflow?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setOpen(false)}>
              Delete
            </Button>
          </>
        }
      >
        This permanently removes “refund-triage” and its version history.
        In-flight runs are unaffected.
      </Dialog>
    </>
  );
}
export const DialogModal: Story = { render: () => <DialogDemo /> };

function DrawerDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open drawer</Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Node inspector"
        footer={
          <Button variant="primary" onClick={() => setOpen(false)}>
            Save
          </Button>
        }
      >
        Configure the selected node here.
      </Drawer>
    </>
  );
}
export const DrawerPanel: Story = { render: () => <DrawerDemo /> };
