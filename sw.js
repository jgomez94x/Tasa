const CACHE_NAME = "tasa-flc-v18";

const urlsToCache = [
  "./",
  "index.html",
  "manifest.json",
  "icon-192.png",
  "icon-512.png",
  "data/rates.json"
];

const adminPanelInject = String.raw`
<style id="adminPanelStyle">
  .visit-counter { cursor: pointer; user-select: none; }
  .admin-panel {
    background: #f7f7f7;
    border: 1px solid #e1e1e1;
    border-radius: 16px;
    display: none;
    margin: 0 20px 18px;
    padding: 14px;
    text-align: left;
  }
  .admin-panel.active { display: block; }
  .admin-head { align-items: center; display: flex; justify-content: space-between; margin-bottom: 12px; }
  .admin-head strong { font-size: 14px; }
  .admin-close { background: transparent; border: none; color: #555; cursor: pointer; font-size: 20px; line-height: 1; padding: 2px 6px; }
  .admin-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 10px; }
  .admin-item { background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 10px 8px; text-align: center; }
  .admin-item span { color: #666; display: block; font-size: 10px; font-weight: 800; margin-bottom: 4px; }
  .admin-item strong { font-size: 18px; }
  .admin-line { color: #666; font-size: 11px; line-height: 1.4; margin-top: 8px; }
</style>
<script id="adminPanelScript">
(() => {
  const SUPABASE_URL_ADMIN = "https://eayaqiqgplvwrxcvxrkn.supabase.co";
  const SUPABASE_ANON_KEY_ADMIN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVheWFxaXFncGx2d3J4Y3Z4cmtuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MTY5NTcsImV4cCI6MjA5MzQ5Mjk1N30.oi-Zeg8s2B6Or-GohZD4FadFvGnqRESpbXVKnStf8j4";
  const VISIT_SESSION_KEY_ADMIN = "tasa-flc-visit-counted-v2";
  const DEVICE_ID_KEY_ADMIN = "tasa-flc-device-id";
  const MODE_SESSION_PREFIX_ADMIN = "tasa-flc-mode-";
  let adminTapCount = 0;
  let adminTapTimer = null;

  function obtenerDeviceIdAdmin() {
    let deviceId = localStorage.getItem(DEVICE_ID_KEY_ADMIN);
    if (!deviceId) {
      deviceId = "dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(DEVICE_ID_KEY_ADMIN, deviceId);
    }
    return deviceId;
  }

  async function llamarSupabaseFuncionAdmin(funcion, body = {}) {
    const res = await fetch(SUPABASE_URL_ADMIN + "/rest/v1/rpc/" + funcion, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_ANON_KEY_ADMIN,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY_ADMIN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error("Error consultando Supabase: " + await res.text());
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  }

  function mostrarVisitasAdmin(data) {
    const counter = document.getElementById("visitCounter");
    if (!counter) return;
    counter.textContent = "T: " + (data?.total_visits ?? "-") + " | D: " + (data?.today_visits ?? "-");
  }

  async function registrarUsoModoAdmin(modo) {
    const key = MODE_SESSION_PREFIX_ADMIN + modo;
    if (sessionStorage.getItem(key) === "1") return;
    try {
      await llamarSupabaseFuncionAdmin("record_mode_use", {
        p_mode: modo,
        p_device_id: obtenerDeviceIdAdmin()
      });
      sessionStorage.setItem(key, "1");
    } catch (error) {
      console.log("No se pudo registrar uso de modo:", error);
    }
  }

  async function actualizarVisitasAdmin() {
    try {
      const yaContado = sessionStorage.getItem(VISIT_SESSION_KEY_ADMIN) === "1";
      const data = yaContado
        ? await llamarSupabaseFuncionAdmin("get_visit_counts")
        : await llamarSupabaseFuncionAdmin("record_app_visit", { p_device_id: obtenerDeviceIdAdmin() });
      if (!yaContado) sessionStorage.setItem(VISIT_SESSION_KEY_ADMIN, "1");
      mostrarVisitasAdmin(data);
      registrarUsoModoAdmin(window.modoActivo || "descuento");
    } catch (error) {
      console.log("Contador privado no disponible:", error);
    }
  }

  function formatoFechaAdmin(fecha) {
    if (!fecha) return "-";
    return new Date(fecha).toLocaleString("es-VE", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  async function cargarPanelAdmin() {
    const detalle = document.getElementById("adminDetalle");
    if (!detalle) return;
    detalle.textContent = "Actualizando panel...";
    try {
      const data = await llamarSupabaseFuncionAdmin("get_admin_stats");
      document.getElementById("adminTotal").textContent = data?.total_visits ?? "-";
      document.getElementById("adminHoy").textContent = data?.today_visits ?? "-";
      document.getElementById("adminEquipos").textContent = data?.unique_devices ?? "-";
      document.getElementById("adminDescuento").textContent = data?.descuento_today ?? "-";
      document.getElementById("adminCambio").textContent = data?.cambio_today ?? "-";
      document.getElementById("adminPagar").textContent = data?.pagar_today ?? "-";
      detalle.textContent = "Hoy por pestana. Totales: Descuento " + (data?.descuento_total ?? 0) + ", Cambio " + (data?.cambio_total ?? 0) + ", Pagar " + (data?.pagar_total ?? 0) + ". Ultima visita: " + formatoFechaAdmin(data?.last_visit_at) + ".";
    } catch (error) {
      console.log("No se pudo cargar panel:", error);
      detalle.textContent = "No se pudo cargar el panel.";
    }
  }

  function crearPanelAdmin() {
    if (document.getElementById("adminPanel")) return;
    const footer = document.querySelector(".footer");
    if (!footer) return;
    footer.insertAdjacentHTML("afterend",
      '<div id="adminPanel" class="admin-panel">' +
      '<div class="admin-head">' +
      '<strong>Panel privado</strong>' +
      '<button class="admin-close" type="button" id="adminClose" aria-label="Cerrar panel">&times;</button>' +
      '</div>' +
      '<div class="admin-grid">' +
      '<div class="admin-item"><span>Visitas</span><strong id="adminTotal">-</strong></div>' +
      '<div class="admin-item"><span>Hoy</span><strong id="adminHoy">-</strong></div>' +
      '<div class="admin-item"><span>Equipos</span><strong id="adminEquipos">-</strong></div>' +
      '</div>' +
      '<div class="admin-grid">' +
      '<div class="admin-item"><span>Descuento</span><strong id="adminDescuento">-</strong></div>' +
      '<div class="admin-item"><span>Cambio</span><strong id="adminCambio">-</strong></div>' +
      '<div class="admin-item"><span>Pagar</span><strong id="adminPagar">-</strong></div>' +
      '</div>' +
      '<div id="adminDetalle" class="admin-line">Toca actualizar dentro de un momento.</div>' +
      '</div>');
    document.getElementById("adminClose").addEventListener("click", () => {
      document.getElementById("adminPanel").classList.remove("active");
    });
  }

  function abrirPanelAdmin() {
    crearPanelAdmin();
    document.getElementById("adminPanel")?.classList.add("active");
    cargarPanelAdmin();
  }

  function toquePanelAdmin() {
    adminTapCount += 1;
    clearTimeout(adminTapTimer);
    adminTapTimer = setTimeout(() => { adminTapCount = 0; }, 1400);
    if (adminTapCount >= 5) {
      adminTapCount = 0;
      abrirPanelAdmin();
    }
  }

  function conectarPanelAdmin() {
    crearPanelAdmin();
    const counter = document.getElementById("visitCounter");
    if (counter && !counter.dataset.adminReady) {
      counter.dataset.adminReady = "1";
      counter.addEventListener("click", toquePanelAdmin);
    }

    const originalCambiarModo = window.cambiarModo;
    if (typeof originalCambiarModo === "function" && !originalCambiarModo.adminWrapped) {
      const wrapped = function(modo) {
        originalCambiarModo(modo);
        window.modoActivo = modo;
        registrarUsoModoAdmin(modo);
      };
      wrapped.adminWrapped = true;
      window.cambiarModo = wrapped;
    }

    actualizarVisitasAdmin();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", conectarPanelAdmin);
  } else {
    conectarPanelAdmin();
  }
})();
</script>`;

function shouldInjectAdminPanel(request, response) {
  const url = new URL(request.url);
  const isHtml = request.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith("index.html");
  return isHtml && response.headers.get("content-type")?.includes("text/html");
}

async function injectAdminPanel(response) {
  let html = await response.text();
  if (html.includes("adminPanelScript")) return new Response(html, response);
  html = html.replace("</body>", adminPanelInject + "</body>");
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "text/html; charset=utf-8");

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (shouldInjectAdminPanel(event.request, response)) {
        return injectAdminPanel(response);
      }
      return response;
    } catch (error) {
      const cached = await caches.match(event.request);
      if (cached && shouldInjectAdminPanel(event.request, cached)) {
        return injectAdminPanel(cached);
      }
      return cached;
    }
  })());
});
