/**
 * English message catalog (default / fallback locale).
 *
 * All user-facing notification strings live here so that delivery logic never
 * hard-codes human-readable text. Keep the key set in sync across locales —
 * keys present here are the fallback used when a translation is missing.
 */
const en: Record<string, string> = {
  // Discord embeds
  'discord.event.title': '📡 Event: {eventName}',
  'discord.event.unknown': 'Unknown Event',
  'discord.field.contract': 'Contract',
  'discord.field.ledger': 'Ledger',
  'discord.field.type': 'Type',
  'discord.field.value': 'Value',
  'discord.test.title': '✅ Test Notification',
  'discord.test.description': 'Discord webhook is working correctly!',

  // Periodic digests
  'digest.title': 'Activity digest',
  'digest.summary': '{count} events between {intervalStart} and {intervalEnd}',
  'digest.empty': 'No activity in this period',
  'digest.event.line': '{eventName} · {contractAddress} · ledger {ledger}',
};

export default en;
