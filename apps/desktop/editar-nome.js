/**
 * Edição de nome no próprio lugar (conversa na barra lateral, DS no Canvas): troca o texto por
 * um campo, Enter ou sair do campo salva, Esc desiste. Sem modal: renomear é coisa rápida.
 *
 * `salvar(nome)` recebe o nome já sem espaço sobrando, só quando mudou de verdade; se lançar,
 * o texto antigo volta e o erro vai pra `aoFalhar`. Devolve uma Promise que resolve quando a
 * edição acaba (`true` = salvou).
 */
export function editarNome(el, { atual, salvar, max = 120, aoFalhar = () => {} }) {
  if (!el || el.querySelector?.("input.nome-edicao")) return Promise.resolve(false);
  const textoAntes = el.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "nome-edicao";
  input.value = atual ?? textoAntes;
  input.maxLength = max;
  input.setAttribute("aria-label", "Novo nome");
  // clique dentro do campo não pode abrir a conversa (a linha inteira é clicável)
  for (const tipo of ["click", "dblclick", "mousedown"]) input.addEventListener(tipo, (e) => e.stopPropagation());
  el.replaceChildren(input);
  input.focus();
  input.select();

  return new Promise((resolve) => {
    let acabou = false;
    const fim = async (gravar) => {
      if (acabou) return;
      acabou = true;
      const nome = input.value.replace(/\s+/g, " ").trim();
      if (!gravar || !nome || nome === (atual ?? textoAntes)) {
        el.textContent = textoAntes;
        resolve(false);
        return;
      }
      el.textContent = nome;
      try {
        await salvar(nome);
        resolve(true);
      } catch (e) {
        el.textContent = textoAntes;
        aoFalhar(e);
        resolve(false);
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        void fim(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        void fim(false);
      }
    });
    input.addEventListener("blur", () => void fim(true));
  });
}
