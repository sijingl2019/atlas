// Twelve menus spell out the same glass popover shadow verbatim. Point them at
// the `--shadow-popover` token so one value can be tuned per mode.
//
// Runs before 01-contrast, while the literal is still identical everywhere.

import { abs, session } from "./lib.mjs";

const s = session("00-popover");
const FROM = `boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.95)"`;
const TO = `boxShadow: "var(--shadow-popover)"`;

const sites = {
  "src/features/artifacts/components/checkpoint-scope-picker.tsx": 1,
  "src/features/chat/components/chat-header.tsx": 1,
  "src/features/chat/components/chat-pinned-menu.tsx": 1,
  "src/features/comms/components/call-menu.tsx": 1,
  "src/features/comms/components/create-channel-menu.tsx": 1,
  "src/features/comms/components/new-dm-menu.tsx": 1,
  "src/features/comms/components/pinned-menu.tsx": 1,
  "src/features/comms/components/rename-channel-menu.tsx": 1,
  "src/features/feedback/components/feedback-panel.tsx": 1,
  "src/features/spaces/components/space-chrome.tsx": 2,
  "src/features/spaces/components/space-toolbar.tsx": 1,
};

let n = 0;
for (const [file, count] of Object.entries(sites)) n += s.literal(abs(file), FROM, TO, count);
s.expect("popover shadow literal -> var(--shadow-popover)", n, 12);
s.commit();
