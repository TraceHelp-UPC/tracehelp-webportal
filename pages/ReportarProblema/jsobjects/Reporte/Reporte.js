export default {
 MAX_BYTES: 10 * 1024 * 1024,
 MAX_ARCHIVOS: 5,
 TIPOS: ['image/png', 'image/jpeg'],
 // Mismas reglas que el backend (US10): así el colaborador ve el error antes de enviar
 validar() {
 const asunto = (InputAsunto.text || '').trim();
 const descripcion = (InputDescripcion.text || '').trim();
 const archivos = FilePickerCapturas.files || [];
 if (!asunto) return 'Escribe un asunto para tu incidente.';
 if (asunto.length > 200) return 'El asunto no puede superar los 200
caracteres.';
 if (descripcion.length < 10) return 'Describe el problema con un poco más de
detalle.';
 if (!RadioImpacto.selectedOptionValue) return 'Indica a quién afecta el
problema.';
 if (archivos.length > this.MAX_ARCHIVOS) return 'Puedes adjuntar como máximo 5
capturas.';
 for (const f of archivos) {
 if (f.type && !this.TIPOS.includes(f.type)) return `"${f.name}" no es PNG ni
JPG.`;
 if (f.size && f.size > this.MAX_BYTES) return `"${f.name}" supera los 10
MB.`;
 }
 return null;
 },
 // El backend responde errores RFC 7807 con el motivo en "detail" (T02)
 detalle(query, porDefecto) {
 let data = query.data;
 if (typeof data === 'string') {
 try { data = JSON.parse(data); } catch (e) { data = null; }
 }
 return (data && data.detail) || porDefecto;
 },
 esCodigo(query, codigo) {
 return String(query.responseMeta?.statusCode ||
'').startsWith(String(codigo));
 },
 async registrar() {
 try {
 return await RegisterTicketQuery.run();
 } catch (e) {
 // Token vencido: se renueva una vez y se reintenta
 if (!this.esCodigo(RegisterTicketQuery, 401)) throw e;
 const r = await RefreshQuery.run();
 await storeValue('accessToken', r.access_token);
 return await RegisterTicketQuery.run();
 }
 },
 async enviar() {
 const error = this.validar();
 if (error) {
 showAlert(error, 'warning');
 return;
 }
 showModal(ModalProcesando.name);
 try {
 const ticket = await this.registrar();
 await storeValue('ultimoTicket', {
 code: ticket.code,
 status: ticket.status,
 title: ticket.title,
 capturas: (ticket.evidences || []).length,
 });
 showAlert(`Registramos tu incidente ${ticket.code}.`, 'success');
 } catch (e) {
 if (this.esCodigo(RegisterTicketQuery, 401) || this.esCodigo(RefreshQuery,
401)) {
 return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
 }
 showAlert(this.detalle(RegisterTicketQuery, 'No pudimos registrar el
incidente. Intenta de nuevo en unos segundos.'), 'error');
 } finally {
 closeModal(ModalProcesando.name);
 }
 },
 async nuevoReporte() {
 await storeValue('ultimoTicket', undefined);
	  resetWidget('ContFormulario', true);
 },
};