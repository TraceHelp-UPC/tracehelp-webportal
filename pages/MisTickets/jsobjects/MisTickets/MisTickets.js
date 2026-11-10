export default {
  rutaHistorial(params) {
    const q = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return q ? `my-history?${q}` : 'my-history';
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
    }
    if (appsmith.store.accessToken) await this.cargar();
  },

  async cargar() {
    const params = {
      status: SelectEstado.selectedOptionValue,
      search: (InputBuscar.text || '').trim(),
      page: TablaTickets.pageNo || 1,
      size: Math.min(Math.max(TablaTickets.pageSize || 10, 1), 100),
    };
    try {
      await this.ejecutar(MisTicketsQuery, { ruta: this.rutaHistorial(params) });
    } catch (e) {
      if (this.esCodigo(MisTicketsQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      if (this.esCodigo(MisTicketsQuery, 400) && params.page > 1) {
        resetWidget('TablaTickets', true);
        await this.ejecutar(MisTicketsQuery, { ruta: this.rutaHistorial({ ...params, page: 1 }) });
        return;
      }
      showAlert(this.detalle(MisTicketsQuery, 'No pudimos cargar tus tickets.'), 'error');
    }
  },

  async filtrar() {
    resetWidget('TablaTickets', true);
    await this.cargar();
  },

  async limpiarFiltros() {
    resetWidget('SelectEstado', true);
    resetWidget('InputBuscar', true);
    resetWidget('TablaTickets', true);
    await this.cargar();
  },

  async cambiarPagina() {
    await this.cargar();
  },

  verDetalle(fila) {
    const row = fila || TablaTickets.triggeredRow || TablaTickets.selectedRow;
    if (!row || !row._id) return;
    navigateTo('DetalleTicket', { ticketId: row._id }, 'SAME_WINDOW');
  },

  etiquetaEstado(st) {
    return {
      OPEN: 'Abierto (en triaje)',
      SELF_SERVICE_PROPOSED: 'Solución sugerida',
      PENDING_ASSIGNMENT: 'En espera de analista',
      ASSIGNED_L1: 'En atención (Nivel 1)',
      ESCALATED_L2: 'Escalado a Nivel 2',
      RESOLVED: 'Resuelto',
      CLOSED: 'Cerrado',
      REOPENED: 'Reabierto',
    }[st] || st;
  },

  filas() {
    return (MisTicketsQuery.data?.items || []).map(t => ({
      _id: t.id,
      'Código': t.code,
      'Título': t.title,
      'Estado': this.etiquetaEstado(t.status),
      'Categoría': t.category || '—',
      'Prioridad': t.priority,
      'Capturas': t.evidence_count || 0,
      'Fecha': new Date(t.created_at).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' }),
    }));
  },

  mensajeVacio() {
    if (SelectEstado.selectedOptionValue || (InputBuscar.text || '').trim()) {
      return 'Ningún ticket coincide con los filtros de búsqueda.';
    }
    return 'Aún no has registrado incidentes. Usa "Reportar problema" cuando necesites ayuda.';
  },
};
