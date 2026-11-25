/**
 * Spanish message catalog.
 *
 * Kept intentionally free of missing keys so the locale is fully usable; the
 * fallback path is exercised in tests with an injected partial catalog.
 */
const es: Record<string, string> = {
  // Discord embeds
  'discord.event.title': '📡 Evento: {eventName}',
  'discord.event.unknown': 'Evento desconocido',
  'discord.field.contract': 'Contrato',
  'discord.field.ledger': 'Libro mayor',
  'discord.field.type': 'Tipo',
  'discord.field.value': 'Valor',
  'discord.test.title': '✅ Notificación de prueba',
  'discord.test.description': '¡El webhook de Discord funciona correctamente!',

  // Periodic digests
  'digest.title': 'Resumen de actividad',
  'digest.summary': '{count} eventos entre {intervalStart} y {intervalEnd}',
  'digest.empty': 'Sin actividad en este período',
  'digest.event.line': '{eventName} · {contractAddress} · libro {ledger}',
};

export default es;
