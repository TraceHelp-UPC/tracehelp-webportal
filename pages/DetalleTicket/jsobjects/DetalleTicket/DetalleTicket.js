export default {
  _sondeando: false,
  _ticksSondeo: 0,

  ticketId() {
    return appsmith.URL.queryParams.ticketId;
  },

  detalle(query, porDefecto) {
    let data = query.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { data = null; }
    }
    return (data && data.detail) || porDefecto;
  },

  esCodigo(query, codigo) {
    return String(query.responseMeta?.statusCode || '').startsWith(String(codigo));
  },

  async ejecutar(query, params = {}) {
    try {
      return await query.run(params);
    } catch (e) {
      if (!this.esCodigo(query, 401)) throw e;
      const r = await RefreshQuery.run();
      await storeValue('accessToken', r.access_token);
      return await query.run(params);
    }
  },

  async alCargar() {
    if (appsmith.mode !== 'EDIT') {
      await Sesion.verificar();
      if (!appsmith.store.accessToken) return;
      if (!this.ticketId()) {
        showAlert('Selecciona un ticket desde Mis tickets.', 'info');
        return navigateTo('MisTickets');
      }
    }
    if (appsmith.store.accessToken && this.ticketId()) {
      this.iniciarSondeo();
      await this.cargar();
    }
  },

  async cargar() {
    const id = this.ticketId();
    try {
      await this.ejecutar(TicketQuery, { id });
    } catch (e) {
      if (this.esCodigo(TicketQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      showAlert(this.detalle(TicketQuery, 'No pudimos abrir el ticket.'), 'error');
      return navigateTo('MisTickets');
    }
    /* El colaborador no consulta /diagnosis (el backend responde 403 a propósito): la
       respuesta de IA llegará con US12/W-03. Aquí solo se muestran comentarios de soporte. */
    try {
      await this.ejecutar(HistorialQuery, { id });
    } catch (e) {
      /* Historial complementario */
    }
    if (!(await this.cargarMensajes()) && !this.esCodigo(MensajesQuery, 401)) {
      showAlert(this.detalle(MensajesQuery, 'No pudimos cargar la conversación.'), 'warning');
    }
    const primera = (TicketQuery.data?.evidences || [])[0];
    if (primera) await this.cargarCaptura(primera.id);
  },

  opcionesCaptura() {
    return (TicketQuery.data?.evidences || []).map((e, i) => ({ label: `Captura ${i + 1}: ${e.file_name}`, value: e.id }));
  },

  async cargarCaptura(evidenceId) {
    const id = evidenceId || SelectCaptura.selectedOptionValue;
    if (!id) return;
    try {
      await this.ejecutar(EvidenciaQuery, { id: this.ticketId(), evidenceId: id });
    } catch (e) {
      showAlert('No pudimos cargar la captura.', 'warning');
    }
  },

  etiquetaEstado(st) {
    return {
      OPEN: 'Abierto (en triaje)',
      SELF_SERVICE_PROPOSED: 'Solución de autoservicio propuesta',
      PENDING_ASSIGNMENT: 'En espera de analista',
      ASSIGNED_L1: 'En atención (Nivel 1)',
      ESCALATED_L2: 'Escalado a Nivel 2',
      RESOLVED: 'Resuelto',
      CLOSED: 'Cerrado',
      REOPENED: 'Reabierto',
    }[st] || st;
  },

  meta() {
    const t = TicketQuery.data;
    if (!t) return '';
    const cat = t.category ? ` · Categoría: ${t.category}` : '';
    return `Estado: ${this.etiquetaEstado(t.status)} · Prioridad: ${t.priority}${cat} · Especialista asignado: ${t.assigned_analyst_name || 'en cola'}`;
  },

  tieneAutoservicio() {
    return TicketQuery.data?.status === 'SELF_SERVICE_PROPOSED';
  },

  estaResuelto() {
    return TicketQuery.data?.status === 'RESOLVED';
  },

  respuesta() {
    const d = DiagnosticoQuery.data;
    if (!d) return {};
    if (d.manual_response) return { summary: 'Respuesta de soporte', steps: [d.manual_response] };
    return d.final_answer || d.ai_answer || {};
  },

  pasosTexto() {
    const pasos = this.respuesta().steps || [];
    if (pasos.length) return pasos.map((s, i) => `${i + 1}. ${s}`).join('<br/>');
    const ultimoComentario = (TicketQuery.data?.comments || []).filter(c => !c.is_internal_note).slice(-1)[0];
    return ultimoComentario ? ultimoComentario.content : 'Revisa los comentarios y bitácora inferior.';
  },

  fuentesTexto() {
    const fuentes = DiagnosticoQuery.data?.ai_answer?.sources || [];
    if (!fuentes.length) return '';
    return 'Fuentes consultadas:<br/>' + fuentes.map(f => `[${f.reference}] ${f.citation}`).join('<br/>');
  },

  bitacora() {
    const t = TicketQuery.data;
    const h = HistorialQuery.data;
    if (!t) return [];
    const fecha = f => new Date(f).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
    const eventos = [{ _orden: t.created_at, Fecha: fecha(t.created_at), Quién: t.reporter_name || 'Tú', Evento: 'Incidente reportado' }];
    (h?.items || []).forEach(item => {
      const motivo = item.reason ? ` — Motivo: ${item.reason}` : '';
      eventos.push({
        _orden: item.changed_at,
        Fecha: fecha(item.changed_at),
        Quién: item.changed_by_name || 'Sistema',
        Evento: `Estado: ${item.previous_status} → ${item.new_status}${motivo}`,
      });
    });
    return eventos.sort((a, b) => new Date(a._orden) - new Date(b._orden)).map(({ _orden, ...e }) => e);
  },

  // ---------- Conversación del ticket (US26 · T86)
  datosMensajes() {
    let d = MensajesQuery.data;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { d = null; }
    }
    return d && Array.isArray(d.items) ? d : null;
  },

  ticketCerrado() {
    const st = TicketQuery.data?.status;
    return st === 'CLOSED' || st === 'RESOLVED';
  },

  escaparHtml(t) {
    return String(t ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  fechaRelativa(iso) {
    const seg = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seg < 60) return 'hace un momento';
    if (seg < 3600) return `hace ${Math.floor(seg / 60)} min`;
    if (seg < 86400) return `hace ${Math.floor(seg / 3600)} h`;
    if (seg < 604800) return `hace ${Math.floor(seg / 86400)} d`;
    return new Date(iso).toLocaleDateString('es-PE', { dateStyle: 'medium' });
  },

  hiloHtml() {
    const raw = MensajesQuery.data;
    const estilos = '<style>'
      + 'body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:8px;background:#F8FAFC;color:#0F172A;font-size:13px}'
      + '.m{max-width:85%;padding:8px 10px;margin:6px 0;border-radius:8px;border:1px solid #E2E8F0;background:#FFFFFF}'
      + '.yo{margin-left:auto;background:#DBEAFE;border-color:#2563EB}'
      + '.nota{background:#FEF3C7;border:1px solid #F59E0B}'
      + '.cab{font-size:11px;color:#64748B;margin-bottom:4px}'
      + '.eti{display:inline-block;font-weight:bold;color:#B45309;margin-left:6px}'
      + '.txt{white-space:pre-wrap;word-wrap:break-word}'
      + '.vacio{color:#64748B;text-align:center;margin-top:40px}'
      + '</style>';
    let datos = raw;
    if (typeof datos === 'string') {
      try { datos = JSON.parse(datos); } catch (e) { datos = null; }
    }
    datos = datos && Array.isArray(datos.items) ? datos : null;
    let cuerpo;
    if (!datos) {
      const fallo = /^[45]/.test(String(MensajesQuery.responseMeta?.statusCode || ''));
      cuerpo = fallo
        ? '<div class="vacio">No pudimos cargar la conversación. Reintentaremos automáticamente.</div>'
        : '<div class="vacio">Cargando mensajes…</div>';
    } else {
      const items = datos.items.filter(m => !m.is_internal_note);
      if (!items.length) {
        cuerpo = '<div class="vacio">Aún no hay mensajes. Escribe el primero para hablar con soporte.</div>';
      } else {
        cuerpo = items.map(m => {
          const mio = m.from_reporter;
          const nombre = m.from_reporter ? 'Tú' : `${this.escaparHtml(m.author_name || 'Soporte')} · Soporte`;
          const ia = m.is_ai_generated ? ' · Respuesta validada' : '';
          const cabecera = `${m.from_reporter ? 'Tú' : nombre}${ia}`;
          const nota = m.is_internal_note;
          const etiqueta = nota ? '<span class="eti">Nota interna · no visible para el colaborador</span>' : '';
          const clases = 'm' + (mio ? ' yo' : '') + (nota ? ' nota' : '');
          return `<div class="${clases}"><div class="cab" title="${this.escaparHtml(new Date(m.created_at).toLocaleString('es-PE'))}">${cabecera} · ${this.fechaRelativa(m.created_at)}${etiqueta}</div><div class="txt">${this.escaparHtml(m.content)}</div></div>`;
        }).join('');
      }
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${estilos}</head><body>${cuerpo}<script>window.scrollTo(0, document.body.scrollHeight);</script></body></html>`;
  },

  async cargarMensajes() {
    try {
      await this.ejecutar(MensajesQuery, { id: this.ticketId() });
      return true;
    } catch (e) {
      if (this.esCodigo(MensajesQuery, 401)) {
        clearInterval('sondeoMensajes');
        await Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      }
      return false;
    }
  },

  // Sondeo silencioso: refresca la conversación cada 8 s y el ticket cada 3 vueltas (~24 s).
  async refrescarMensajes(forzarTicket = false) {
    if (!appsmith.store.accessToken || !this.ticketId()) {
      clearInterval('sondeoMensajes');
      return;
    }
    if (this._sondeando) return;
    this._sondeando = true;
    try {
      this._ticksSondeo = (this._ticksSondeo || 0) + 1;
      const refrescarTicket = Boolean(forzarTicket) || this._ticksSondeo % 3 === 0;
      if (refrescarTicket) {
        try {
          await this.ejecutar(TicketQuery, { id: this.ticketId() });
        } catch (e) {
          if (this.esCodigo(TicketQuery, 401)) {
            clearInterval('sondeoMensajes');
            return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
          }
        }
      }
      await this.cargarMensajes();
      if (this.esCodigo(MensajesQuery, 401)) {
        clearInterval('sondeoMensajes');
      }
    } finally {
      this._sondeando = false;
    }
  },

  iniciarSondeo() {
    clearInterval('sondeoMensajes');
    if (!appsmith.store.accessToken || !this.ticketId()) return;
    this._ticksSondeo = 0;
    setInterval(() => DetalleTicket.refrescarMensajes(), 8000, 'sondeoMensajes');
  },

  mensajeErrorEnvio() {
    let d = EnviarMensajeQuery.data;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { d = null; }
    }
    const codigo = String(EnviarMensajeQuery.responseMeta?.statusCode || '');
    if (codigo.startsWith('422')) {
      const tipo = ((d && d.errors) || [])[0]?.type;
      if (tipo === 'string_too_short') return 'El mensaje no puede estar vacío.';
      if (tipo === 'string_too_long') return 'El mensaje no puede superar los 2000 caracteres.';
      return (d && d.detail) || 'El mensaje no es válido.';
    }
    if (codigo.startsWith('403')) return 'No tienes permiso para escribir en este ticket.';
    if (codigo.startsWith('404')) return 'El ticket ya no existe.';
    if (codigo.startsWith('409')) return (d && d.detail) || 'Este ticket no admite nuevos mensajes en su estado actual.';
    return (d && d.detail) || 'No pudimos enviar tu mensaje. Inténtalo de nuevo.';
  },

  async enviarMensaje() {
    const content = (InputMensaje.text || '').trim();
    if (!content) {
      showAlert('El mensaje no puede estar vacío.', 'warning');
      return;
    }
    if (content.length > 2000) {
      showAlert('El mensaje no puede superar los 2000 caracteres.', 'warning');
      return;
    }
    if (this.ticketCerrado()) {
      const aviso = TicketQuery.data?.status === 'RESOLVED'
        ? 'Este ticket está resuelto. Para continuar la conversación, primero debes reabrirlo.'
        : 'Este ticket está cerrado y no admite nuevos mensajes.';
      showAlert(aviso, 'warning');
      return;
    }
    const body = { content };
    try {
      await this.ejecutar(EnviarMensajeQuery, { id: this.ticketId(), body });
    } catch (e) {
      if (this.esCodigo(EnviarMensajeQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      showAlert(this.mensajeErrorEnvio(), this.esCodigo(EnviarMensajeQuery, 5) ? 'error' : 'warning');
      if (this.esCodigo(EnviarMensajeQuery, 409)) {
        try { await this.ejecutar(TicketQuery, { id: this.ticketId() }); } catch (e2) { /* el aviso ya se mostró */ }
      }
      return;
    }
    resetWidget('InputMensaje', true);
    showAlert('Mensaje enviado.', 'success');
    await this.cargarMensajes();
  },

  async cambiarEstado(targetStatus, reason, msgExito, modal) {
    try {
      await this.ejecutar(CambiarEstadoQuery, {
        id: this.ticketId(),
        body: { status: targetStatus, reason: (reason || '').trim() || null },
      });
      if (modal) closeModal(modal);
      showAlert(msgExito, 'success');
    } catch (e) {
      if (this.esCodigo(CambiarEstadoQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      showAlert(this.detalle(CambiarEstadoQuery, 'No pudimos actualizar el estado del ticket.'), 'warning');
      return;
    }
    await this.cargar();
  },

  async aceptarSolucion() {
    await this.cambiarEstado('RESOLVED', 'El colaborador confirmó que la solución de autoservicio resolvió su incidente', '¡Excelente! Tu ticket quedó marcado como resuelto.');
  },

  async rechazarSolucion() {
    await this.cambiarEstado('PENDING_ASSIGNMENT', 'La solución de autoservicio no resolvió el incidente; solicita atención de un analista', 'Derivamos tu ticket a la cola de analistas de soporte.');
  },

  async confirmarCierre() {
    await this.cambiarEstado('CLOSED', 'Cierre confirmado por el colaborador', 'Has confirmado el cierre definitivo del ticket.');
  },

  abrirReabrir() {
    resetWidget('InputMotivoReabrir', true);
    showModal(ModalReabrir.name);
  },

  async confirmarReabrir() {
    const motivo = (InputMotivoReabrir.text || '').trim() || 'El incidente persiste luego de la solución';
    await this.cambiarEstado('REOPENED', motivo, 'Tu ticket fue reabierto para revisión de soporte.', ModalReabrir.name);
  },
};
