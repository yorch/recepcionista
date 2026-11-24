/**
 * Spanish callers describe the same jobs with different words: bridge them to the English service names the receptionist matches against
 * (get_pricing / check_availability / create_booking). One map for every vertical: a word only matters when a service of that trade uses it.
 */
export const SERVICE_ALIASES: Readonly<Record<string, string>> = {
  // generic
  reparacion: 'repair', reparación: 'repair', arreglar: 'repair', arreglo: 'repair',
  instalacion: 'installation', instalación: 'installation', instalar: 'installation',
  mantenimiento: 'maintenance', afinacion: 'maintenance', afinación: 'maintenance',
  servicio: 'service', diagnostico: 'diagnostic', diagnóstico: 'diagnostic',
  revision: 'diagnostic', revisión: 'diagnostic', visita: 'visit',
  limpieza: 'cleaning', emergencia: 'emergency', emergencias: 'emergency', urgencia: 'emergency',
  consulta: 'consultation', cotizacion: 'estimate', cotización: 'estimate',
  // heating and cooling
  ductos: 'duct', conductos: 'duct', aire: 'ac', acondicionado: 'ac', equipo: 'system', sistema: 'system',
  calefaccion: 'heating', calefacción: 'heating', calentar: 'heating',
  // plumbing
  fuga: 'leak', fugas: 'leak', drenaje: 'drain', drenajes: 'drain', desague: 'drain', desagüe: 'drain', destape: 'drain', destapar: 'drain',
  plomeria: 'plumbing', plomería: 'plumbing', calentador: 'heater', grifo: 'faucet', inodoro: 'toilet',
  // electrical
  electrico: 'electrical', eléctrico: 'electrical', electrica: 'electrical', eléctrica: 'electrical', luces: 'lighting', ventilador: 'fan', cargador: 'charger',
  // cleaning and landscaping
  profunda: 'deep', mudanza: 'move', oficina: 'office', cesped: 'lawn', césped: 'lawn', pasto: 'lawn', jardin: 'yard', jardín: 'yard', poda: 'trimming', podar: 'trimming', corte: 'mowing',
  // dental
  dental: 'dental', diente: 'tooth', dientes: 'teeth', blanqueamiento: 'whitening', empaste: 'filling', examen: 'exam',
};
