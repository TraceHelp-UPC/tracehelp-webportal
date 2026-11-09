export default {
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
    if (appsmith.store.accessToken && this.ticketId()) await this.cargar();
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
    try {
      await this.ejecutar(DiagnosticoQuery, { id });
    } catch (e) {
      /* Solo hay diagnóstico visible cuando hay autoservicio propuesto */
    }
    try {
      await this.ejecutar(HistorialQuery, { id });
    } catch (e) {
      /* Historial complementario */
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
    (t.comments || []).filter(c => !c.is_internal_note).forEach(c => eventos.push({
      _orden: c.created_at,
      Fecha: fecha(c.created_at),
      Quién: c.author_name || 'Soporte',
      Evento: `Mensaje: ${c.content}`,
    }));
    return eventos.sort((a, b) => new Date(a._orden) - new Date(b._orden)).map(({ _orden, ...e }) => e);
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
