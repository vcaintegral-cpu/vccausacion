import { describe, expect, it } from 'vitest';
import { resolveLineAccount, applyEngineToLines } from './causacion-engine';
import { buildJournal, type Line } from './accounting';
import { classifyJournal, alertasBorrador, type DraftInvoice } from './draft-review';
const line: Line = { description: 'Licencia derechos musicales', quantity: 1, unit_value: 8444445, discount: 0, iva: 0, retention: 0, impoconsumo: 0, total: 8444445 };
const params = { providerNit: '860006810', knowledge: { learning: [], history: [] }, products: [], categories: [], rules: [], puc: [] };
describe('reglas de causación solicitadas', () => {
 it('elimina el nombre Bancolombia al rechazar la cuenta 11200502', () => {
  const result = applyEngineToLines([{ ...line, account_code: '11200502', account_name: 'Bancolombia' }], params);
  expect(result.lines[0]?.account_name).toBe('');
 });
 it('normaliza el NIT del historial sin confundirlo con otros proveedores', () => {
  const result = resolveLineAccount({ ...params, line, providerNit: '811.016.618', knowledge: { learning: [], history: [{ provider_nit: '811.016.618', account_code: '51350501', concept: 'Aseo', voucher: 'FC-1-619', entry_date: '2026-06-06' }] } });
  expect(result.code).toBe('51350501'); expect(result.origin).toBe('HISTORIAL');
 });
 it('SAYCO sin historial no recibe Bancolombia ni gasto genérico', () => {
  const result = resolveLineAccount({ ...params, line, provider: { default_expense_account: '11200502' } });
  expect(result.code).toBe(''); expect(result.origin).toBe('NINGUNA');
 });
 it('rechaza banco aunque venga guardado en la línea', () => {
  const result = applyEngineToLines([{ ...line, account_code: '11200502' }], params);
  expect(result.lines[0]?.account_code).toBe('');
 });
 it('usa compra del mismo NIT antes que catálogo y otro proveedor', () => {
  const result = resolveLineAccount({ ...params, line, providerNit: '811016618', products: [{ code: 'X', name: line.description, kind: 'gasto', category: null, account_code: '11200502', account_name: '' }], knowledge: { learning: [], history: [{ provider_nit: '811016618', account_code: '51350501', concept: 'Aseo', voucher: 'FC-1-619', entry_date: '2026-06-06' }, { provider_nit: 'otro', account_code: '51101001', concept: line.description }] } });
  expect(result.code).toBe('51350501'); expect(result.origin).toBe('HISTORIAL'); expect(result.reason).toContain('FC-1-619');
 });
 it('historial por descripción requiere coincidencia y gasto válido', () => {
  const result = resolveLineAccount({ ...params, line, knowledge: { learning: [], history: [{ provider_nit: 'otro', account_code: '11200502', concept: line.description }, { provider_nit: 'otro', account_code: '51359501', concept: line.description }] } });
  expect(result.code).toBe('51359501'); expect(result.origin).toBe('HISTORIAL_DESCRIPCION');
 });
 it('asiento sin cuenta conserva pendiente sin inventar 519595', () => {
  const result = buildJournal({ lines: [line], iva: 0, retenciones: { retefuente: 0, reteiva: 0, reteica: 0, autorretencion: 0, detalle: [] } });
  expect(result[0]?.account_code).toBe(''); expect(result[0]?.debit).toBe(8444445);
 });
 it('bloquea banco en borrador existente aun si el gasto mayor es válido', () => {
  const acc = classifyJournal([{ invoice_id: 'i', account_code: '51350501', account_name: '', debit: 1000, credit: 0, cost_center: null }, { invoice_id: 'i', account_code: '11200502', account_name: 'Banco', debit: 100, credit: 0, cost_center: null }]);
  const alerts = alertasBorrador({ id: 'i', total: 1100, subtotal: 1100 } as DraftInvoice, acc, new Set());
  expect(alerts.some((a) => a.level === 'error' && a.message.includes('11200502'))).toBe(true);
 });
});
