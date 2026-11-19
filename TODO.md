# Veyra Study — Follow-ups & Notes

## UI & Motion
- [ ] **Messages popup opening animation**: Rework the opening animation for the Messages popup/dialogs (e.g., New message dialog and any popups inside Messages) so they animate in cleanly from their trigger/origin with a smoother spring curve instead of the default centered dialog animation.

## Messaging Privacy
- [ ] **Server-side privacy enforcement (next Galaxy A54 server deploy)**: Messaging privacy preferences (`Who can text you`, `Who can send message requests`, `Who can add you to groups`) are currently enforced client-side across Messages, Group work, unread badges, and notifications so they work immediately with zero server deploy. In a future `server/group-server.mjs` release, mirror these checks on `POST /groups/:id/invites` so disallowed invites are also rejected at the server boundary.
