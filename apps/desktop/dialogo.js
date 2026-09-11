/**
 * Confirmação/aviso no visual do app, em vez de `window.confirm`/`window.alert` (a caixa nativa do
 * SO — sem a marca, sem o tema escuro). Modal único e reaproveitado: `confirmar` mostra
 * Cancelar/OK e resolve `true`/`false`; `avisar` mostra só OK. Mesmo padrão de dependência por
 * parâmetro de `file-tree.js`/`hooks-studio.js` — dá pra testar sem Electron.
 */
export function createDialogo({ el }) {
  /** Resolve a promessa em aberto; `null` quando o modal está fechado. */
  let resolver = null;

  function fechar(resultado) {
    el("dlg-modal").classList.add("hidden");
    const r = resolver;
    resolver = null;
    if (r) r(resultado);
  }

  function abrir(mensagem, { comCancelar, textoOk }) {
    el("dlg-msg").textContent = mensagem;
    el("btn-dlg-cancel").classList.toggle("hidden", !comCancelar);
    el("btn-dlg-ok").textContent = textoOk;
    el("dlg-modal").classList.remove("hidden");
    el("btn-dlg-ok").focus();
    return new Promise((resolve) => {
      resolver = resolve;
    });
  }

  /** Mesma semântica de `window.confirm`: `true` = confirmou, `false` = cancelou/fechou. */
  function confirmar(mensagem, textoOk = "OK") {
    return abrir(mensagem, { comCancelar: true, textoOk });
  }

  /** Mesma semântica de `window.alert`: só informa, sem escolha. */
  async function avisar(mensagem) {
    await abrir(mensagem, { comCancelar: false, textoOk: "OK" });
  }

  function ligar() {
    el("btn-dlg-ok").addEventListener("click", () => fechar(true));
    el("btn-dlg-cancel").addEventListener("click", () => fechar(false));
    el("dlg-modal").addEventListener("click", (e) => {
      if (e.target.id === "dlg-modal") fechar(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && resolver) fechar(false);
    });
  }

  return { confirmar, avisar, ligar };
}
