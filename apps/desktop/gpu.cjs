/**
 * Queda do processo GPU do Chromium. Com driver ruim (visto em Intel UHD 750, D3D11), o GPU trava
 * no boot; o renderer, que espera o GPU em chamada síncrona (canvas), congela junto: a tela de
 * abertura para no 1º passo e nem o relógio dela anda. O Chromium mata o GPU travado e sobe outro,
 * que pode travar de novo.
 *
 * Aqui só a regra, sem Electron: cada queda vai pra `gpu.json` no userData. `QUEDAS_PRA_DESLIGAR`
 * quedas em `JANELA_MS` (somando boots, porque a pessoa costuma matar o app congelado antes da 2ª)
 * desligam a aceleração no próximo boot. Volta sozinha depois de `SEM_GPU_POR_MS` (driver pode ter
 * sido atualizado) ou quando a pessoa pede.
 */
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const QUEDAS_PRA_DESLIGAR = 2;
const JANELA_MS = 24 * 60 * 60 * 1000;
const SEM_GPU_POR_MS = 7 * 24 * 60 * 60 * 1000;

/** `clean-exit` é o Chromium fechando o GPU de propósito (app saindo), não queda. */
function ehQuedaDeGpu(details) {
  return details?.type === "GPU" && details.reason !== "clean-exit";
}

function criarGpu({ dir, agora = () => Date.now() }) {
  const arq = () => join(dir(), "gpu.json");
  const ler = () => {
    try {
      const raw = JSON.parse(readFileSync(arq(), "utf8"));
      return {
        quedas: Array.isArray(raw.quedas) ? raw.quedas.filter(Number.isFinite) : [],
        semAceleracaoDesde: Number.isFinite(raw.semAceleracaoDesde) ? raw.semAceleracaoDesde : 0,
      };
    } catch {
      return { quedas: [], semAceleracaoDesde: 0 };
    }
  };
  const gravar = (e) => {
    try {
      writeFileSync(arq(), JSON.stringify(e), "utf8");
    } catch {
      /* userData sem escrita: segue com GPU, só não lembra */
    }
  };

  return {
    /** Lido antes do `ready`: true = subir com `app.disableHardwareAcceleration()`. */
    semAceleracao() {
      const e = ler();
      if (!e.semAceleracaoDesde) return false;
      if (agora() - e.semAceleracaoDesde < SEM_GPU_POR_MS) return true;
      gravar({ quedas: [], semAceleracaoDesde: 0 });
      return false;
    },
    /** Devolve `{ quedas, desligou }`: `desligou` só na queda que cruza o limite. */
    registrarQueda() {
      const t = agora();
      const e = ler();
      const quedas = [...e.quedas.filter((q) => t - q < JANELA_MS), t];
      const desligou = !e.semAceleracaoDesde && quedas.length >= QUEDAS_PRA_DESLIGAR;
      gravar({ quedas, semAceleracaoDesde: desligou ? t : e.semAceleracaoDesde });
      return { quedas: quedas.length, desligou };
    },
    reativar() {
      gravar({ quedas: [], semAceleracaoDesde: 0 });
    },
  };
}

module.exports = { criarGpu, ehQuedaDeGpu, QUEDAS_PRA_DESLIGAR, JANELA_MS, SEM_GPU_POR_MS };
