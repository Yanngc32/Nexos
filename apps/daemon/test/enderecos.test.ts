import { describe, expect, it } from "vitest";
import { classificar, enderecosDaMaquina, escolherHostDoCelular, ondeEscutar } from "../src/enderecos.ts";

describe("classificar", () => {
  it("loopback", () => {
    for (const h of ["127.0.0.1", "127.0.0.53", "::1"]) expect(classificar(h), h).toBe("loopback");
  });

  it("Tailscale é reconhecido pelo endereço, não pelo nome da interface", () => {
    // é o que faz a detecção funcionar em máquina onde a interface tem outro
    // nome, e é o caso que importa: 100.64/10 é o CGNAT que o Tailscale usa
    expect(classificar("100.101.102.103", "eth0")).toBe("tunel");
    expect(classificar("100.64.0.1", "qualquercoisa")).toBe("tunel");
    expect(classificar("100.127.255.254", "")).toBe("tunel");
    expect(classificar("fd7a:115c:a1e0::1", "eth0")).toBe("tunel");
  });

  it("as bordas do bloco 100.64/10 — errar a máscara pegaria IP público", () => {
    // 100.64.0.0/10 vai de 100.64.0.0 a 100.127.255.255. Um /8 por descuido
    // engoliria 100.0.0.0–100.63.255.255, que é internet de verdade.
    expect(classificar("100.63.255.255")).toBe("publico");
    expect(classificar("100.128.0.0")).toBe("publico");
  });

  it("WireGuard puro não tem bloco reservado, então vale o nome da interface", () => {
    // quem configura escolhe o endereço, e costuma ser 10.x — que sem o nome
    // da interface seria LAN
    expect(classificar("10.8.0.2", "wg0")).toBe("tunel");
    expect(classificar("10.8.0.2", "eth0")).toBe("lan");
    for (const n of ["tun0", "utun3", "tailscale0", "nordlynx", "wt0"]) {
      expect(classificar("10.8.0.2", n), n).toBe("tunel");
    }
  });

  it("LAN é LAN — não entra por engano", () => {
    for (const h of ["192.168.0.42", "10.0.0.7", "172.16.5.1", "172.31.255.254"]) {
      expect(classificar(h, "eth0"), h).toBe("lan");
    }
    // 172.32 já saiu do /12
    expect(classificar("172.32.0.1", "eth0")).toBe("publico");
  });

  it("link-local fica de fora: não roteia e IPv6 exigiria %zona na URL", () => {
    expect(classificar("169.254.1.2", "eth0")).toBe("link-local");
    expect(classificar("fe80::1", "eth0")).toBe("link-local");
    expect(classificar("fe80::1%wg0", "wg0")).toBe("link-local");
  });

  it("público é público", () => {
    for (const h of ["8.8.8.8", "203.0.113.7", "2606:4700::1"]) {
      expect(classificar(h, "eth0"), h).toBe("publico");
    }
  });
});

describe("enderecosDaMaquina", () => {
  const falso = () => ({
    lo: [{ address: "127.0.0.1", internal: true, family: "IPv4" }],
    eth0: [
      { address: "192.168.0.42", internal: false, family: "IPv4" },
      { address: "fe80::1", internal: false, family: "IPv6" },
    ],
    tailscale0: [
      { address: "100.101.102.103", internal: false, family: "IPv4" },
      { address: "fd7a:115c:a1e0::abcd", internal: false, family: "IPv6" },
    ],
  });

  it("classifica tudo que a máquina tem", () => {
    const por = Object.fromEntries(enderecosDaMaquina(falso).map((e) => [e.host, e.classe]));
    expect(por).toEqual({
      "127.0.0.1": "loopback",
      "192.168.0.42": "lan",
      "fe80::1": "link-local",
      "100.101.102.103": "tunel",
      "fd7a:115c:a1e0::abcd": "tunel",
    });
  });

  it("guarda de qual interface veio, pra tela poder explicar", () => {
    const t = enderecosDaMaquina(falso).find((e) => e.host === "100.101.102.103");
    expect(t?.interface).toBe("tailscale0");
  });

  it("endereço repetido em duas interfaces aparece uma vez", () => {
    const dobrado = () => ({
      a: [{ address: "100.64.0.1", internal: false, family: "IPv4" }],
      b: [{ address: "100.64.0.1", internal: false, family: "IPv4" }],
    });
    expect(enderecosDaMaquina(dobrado)).toHaveLength(1);
  });

  it("máquina sem nada não estoura", () => {
    expect(enderecosDaMaquina(() => ({}))).toEqual([]);
    expect(enderecosDaMaquina(() => ({ lo: undefined }))).toEqual([]);
  });
});

describe("ondeEscutar", () => {
  const tunel = { host: "100.101.102.103", classe: "tunel" as const, interface: "tailscale0" };
  const lan = { host: "192.168.0.42", classe: "lan" as const, interface: "eth0" };
  const publico = { host: "203.0.113.7", classe: "publico" as const, interface: "eth0" };

  it("loopback sempre primeiro, e sempre presente", () => {
    // é por ele que o app do desktop fala com o daemon: sem ele, nada funciona
    expect(ondeEscutar([])).toEqual(["127.0.0.1"]);
    expect(ondeEscutar([tunel])[0]).toBe("127.0.0.1");
  });

  it("túnel entra sozinho — é o ponto de tudo isto", () => {
    expect(ondeEscutar([tunel])).toEqual(["127.0.0.1", "100.101.102.103"]);
  });

  it("IPv4 do Tailscale vem antes do IPv6 e de outro 100.x — é o que o QR carrega", () => {
    const v6 = { host: "fd7a:115c:a1e0::1", classe: "tunel" as const, interface: "Tailscale" };
    const wg = { host: "100.64.0.1", classe: "tunel" as const, interface: "wt0" };
    const ts4 = { host: "100.99.0.1", classe: "tunel" as const, interface: "Tailscale" };
    expect(ondeEscutar([v6, wg, ts4])).toEqual(["127.0.0.1", "100.99.0.1", "100.64.0.1", "fd7a:115c:a1e0::1"]);
  });

  it("LAN e público NÃO entram por conta própria", () => {
    // publicar no Wi-Fi compartilhado é escolha, não conveniência; e IP público
    // seria o Nexo na internet
    expect(ondeEscutar([lan, publico])).toEqual(["127.0.0.1"]);
  });

  it("o que você escreveu à mão entra, mesmo sendo LAN", () => {
    // escolha explícita ganha de heurística
    expect(ondeEscutar([], "192.168.0.42")).toEqual(["127.0.0.1", "192.168.0.42"]);
  });

  it("escutar em tudo substitui a lista em vez de somar", () => {
    // 0.0.0.0 já inclui o loopback; ligar os dois na mesma porta dá EADDRINUSE
    expect(ondeEscutar([tunel], "0.0.0.0")).toEqual(["0.0.0.0"]);
    expect(ondeEscutar([tunel], "::")).toEqual(["::"]);
  });

  it("não repete, e não põe loopback duas vezes", () => {
    expect(ondeEscutar([tunel, tunel], "127.0.0.1")).toEqual(["127.0.0.1", "100.101.102.103"]);
    expect(ondeEscutar([tunel], "100.101.102.103")).toEqual(["127.0.0.1", "100.101.102.103"]);
    expect(ondeEscutar([], "localhost")).toEqual(["127.0.0.1"]);
  });

  it("máquina de verdade sempre dá pelo menos o loopback", () => {
    // guarda contra a detecção devolver lista vazia e o daemon não escutar nada
    expect(ondeEscutar(enderecosDaMaquina())).toContain("127.0.0.1");
  });
});

describe("escolherHostDoCelular", () => {
  const maquina = [
    { host: "127.0.0.1", classe: "loopback" as const, interface: "lo" },
    { host: "fd7a:115c:a1e0::1", classe: "tunel" as const, interface: "Tailscale" },
    { host: "100.99.0.1", classe: "tunel" as const, interface: "Tailscale" },
    { host: "100.64.0.1", classe: "tunel" as const, interface: "wt0" },
  ];

  it("IPv4 do Tailscale ganha do IPv6, mesmo o IPv6 vindo primeiro na lista", () => {
    expect(
      escolherHostDoCelular(["127.0.0.1", "fd7a:115c:a1e0::1", "100.99.0.1", "100.64.0.1"], maquina),
    ).toBe("100.99.0.1");
  });

  it("sem Tailscale IPv4, outro túnel IPv4 ainda ganha do IPv6", () => {
    expect(escolherHostDoCelular(["fd7a:115c:a1e0::1", "100.64.0.1"], maquina)).toBe("100.64.0.1");
  });

  it("só loopback devolve loopback, não vazio", () => {
    expect(escolherHostDoCelular(["127.0.0.1"], maquina)).toBe("127.0.0.1");
  });
});
