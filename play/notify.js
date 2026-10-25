// The "Tell me when …" toggle on the game pages (tic-tac-toe, blackjack) and the market: what it may do with browser
// notifications. Pure, no DOM, so tests/sdk/turn-alert.test.mjs can run it.

/**
 * What the "Tell me when it's my move" toggle does when clicked (or restored from the saved choice).
 * `ask`: call Notification.requestPermission() (only ever from a click). `on`: notifications are enabled. `note`: what
 * to tell the player when they cannot be. `when`: what the tab title still shows, for a page that is not a game's turn
 * (the market says "an order fills").
 * @param {{supported: boolean, permission: string, wanted: boolean, when?: string}} o
 */
export function notifyPlan({ supported, permission, wanted, when = 'it is your move' }) {
  if (!wanted) return { ask: false, on: false, note: '' };
  if (!supported) return { ask: false, on: false, note: `This browser does not support notifications. The tab title still shows when ${when}.` };
  if (permission === 'denied') return { ask: false, on: false, note: `Notifications are blocked for this site in your browser settings. The tab title still shows when ${when}.` };
  if (permission === 'granted') return { ask: false, on: true, note: '' };
  return { ask: true, on: false, note: '' };
}
