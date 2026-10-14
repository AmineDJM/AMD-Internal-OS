import { describe, expect, it } from "vitest";
import {
  analyserAgent, bornesPeriode, cleDeSeau, ecartPoints, formatDuree, hoteDuReferent, ilYA, libelleDeSeau, lirePeriode,
  normaliserChemin, normaliserCible, nomDuPays, paysDepuisEntetes, seauxDeLaPeriode, serieComplete, slugDeLAdresse, slugSous,
  sourceDepuis, taux, tauxDeRebond, validerEvenement, validerLot, variation, DUREE_MAX_MS, LOT_MAX, libelleClic,
} from "./audience-calc";
import { scriptAudience } from "./audience-script";

const UA = {
  chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  androidTablette: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:129.0) Gecko/20100101 Firefox/129.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  opera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 OPR/113.0.0.0",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  facebook: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  headless: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
  curl: "curl/8.4.0",
};

describe("analyserAgent — trois mots, jamais l'agent lui-même", () => {
  it("appareil, navigateur, système", () => {
    expect(analyserAgent(UA.chromeWindows)).toEqual({ robot: false, device: "Ordinateur", browser: "Chrome", os: "Windows" });
    expect(analyserAgent(UA.edge)).toMatchObject({ browser: "Edge", os: "Windows" });
    expect(analyserAgent(UA.iphone)).toEqual({ robot: false, device: "Mobile", browser: "Safari", os: "iOS" });
    expect(analyserAgent(UA.ipad)).toMatchObject({ device: "Tablette", os: "iOS" });
    expect(analyserAgent(UA.androidChrome)).toEqual({ robot: false, device: "Mobile", browser: "Chrome", os: "Android" });
    expect(analyserAgent(UA.androidTablette)).toMatchObject({ device: "Tablette", os: "Android" });
    expect(analyserAgent(UA.samsung)).toMatchObject({ device: "Mobile", browser: "Samsung Internet" });
    expect(analyserAgent(UA.firefoxMac)).toEqual({ robot: false, device: "Ordinateur", browser: "Firefox", os: "macOS" });
    expect(analyserAgent(UA.safariMac)).toMatchObject({ browser: "Safari", os: "macOS" });
    expect(analyserAgent(UA.opera)).toMatchObject({ browser: "Opera" });
  });

  it("les robots connus, et l'agent vide, sont des robots", () => {
    for (const ua of [UA.googlebot, UA.facebook, UA.headless, UA.curl, "", null]) expect(analyserAgent(ua).robot, String(ua)).toBe(true);
    expect(analyserAgent(UA.iphone).robot).toBe(false);
  });
});

describe("sourceDepuis — d'où vient la visite", () => {
  const hotes = ["adventumdz.com"];
  it("utm_source l'emporte, normalisé", () => {
    expect(sourceDepuis({ utmSource: "linkedin", referrerHost: "google.com" })).toBe("LinkedIn");
    expect(sourceDepuis({ utmSource: "Facebook" })).toBe("Facebook");
    expect(sourceDepuis({ utmSource: "newsletter" })).toBe("E-mail");
    expect(sourceDepuis({ utmSource: "emploitic" })).toBe("Emploitic");
    expect(sourceDepuis({ utmSource: "salon-pharma" })).toBe("Salon-pharma");
  });
  it("sinon le référent", () => {
    expect(sourceDepuis({ referrerHost: "google.dz" })).toBe("Google");
    expect(sourceDepuis({ referrerHost: "google.com" })).toBe("Google");
    expect(sourceDepuis({ referrerHost: "mail.google.com" })).toBe("E-mail");
    expect(sourceDepuis({ referrerHost: "bing.com" })).toBe("Bing");
    expect(sourceDepuis({ referrerHost: "lnkd.in" })).toBe("LinkedIn");
    expect(sourceDepuis({ referrerHost: "l.facebook.com" })).toBe("Facebook");
    expect(sourceDepuis({ referrerHost: "l.instagram.com" })).toBe("Instagram");
    expect(sourceDepuis({ referrerHost: "t.co" })).toBe("X (Twitter)");
    expect(sourceDepuis({ referrerHost: "wa.me" })).toBe("WhatsApp");
    expect(sourceDepuis({ referrerHost: "dz.emploitic.com" })).toBe("Emploitic");
    expect(sourceDepuis({ referrerHost: "outlook.live.com" })).toBe("E-mail");
    expect(sourceDepuis({ referrerHost: "exemple.org" })).toBe("Autre");
  });
  it("sans référent, ou depuis le site lui-même : Direct", () => {
    expect(sourceDepuis({})).toBe("Direct");
    expect(sourceDepuis({ referrerHost: "adventumdz.com", hotesDuSite: hotes })).toBe("Direct");
  });
  it("le référent n'est gardé qu'à son hôte", () => {
    expect(hoteDuReferent("https://www.Google.com/search?q=adventum+emploi")).toBe("google.com");
    expect(hoteDuReferent("linkedin.com")).toBe("linkedin.com");
    expect(hoteDuReferent("javascript:alert(1)")).toBeNull();
    expect(hoteDuReferent("")).toBeNull();
    expect(hoteDuReferent("pas un hote")).toBeNull();
  });
});

describe("validerEvenement — strict", () => {
  it("une page vue : chemin relatif sans paramètres ni ancre, titre borné", () => {
    const e = validerEvenement({ type: "pageview", path: "/carrieres/delegue-alger/?email=a@b.c#x", title: "x".repeat(500), referrer: "https://www.linkedin.com/feed/" });
    expect(e).toMatchObject({ type: "PAGEVIEW", path: "/carrieres/delegue-alger", referrer: "linkedin.com" });
    expect(e!.title!.length).toBe(200);
  });
  it("refuse ce qui n'est pas un chemin du site, ou un type inconnu", () => {
    for (const path of ["https://evil.test/", "//evil.test/x", "carrieres", "/a\\b", "/x\u0000y", `/${"a".repeat(400)}`, 42, null]) {
      expect(validerEvenement({ type: "PAGEVIEW", path }), String(path)).toBeNull();
    }
    expect(validerEvenement({ type: "PURCHASE", path: "/" })).toBeNull();
    expect(validerEvenement("PAGEVIEW")).toBeNull();
    expect(validerEvenement([])).toBeNull();
  });
  it("un clic : libellé normalisé, cible sans paramètres", () => {
    expect(validerEvenement({ type: "CLICK", path: "/contact", label: "Telephone", target: "tel:+213555000000" }))
      .toMatchObject({ label: "telephone", target: "tel:+213555000000", title: null });
    expect(validerEvenement({ type: "CLICK", path: "/", label: "mauvais libellé !", target: "https://www.exemple.org/doc.pdf?token=secret" }))
      .toMatchObject({ label: "cta", target: "exemple.org/doc.pdf" });
    expect(normaliserCible("mailto:rh@adventumdz.com?subject=Candidature")).toBe("mailto:rh@adventumdz.com");
  });
  it("une sortie : durée positive, plafonnée à 30 min", () => {
    expect(validerEvenement({ type: "LEAVE", path: "/", durationMs: 12_345.6 })).toMatchObject({ durationMs: 12_346 });
    expect(validerEvenement({ type: "LEAVE", path: "/", durationMs: 10 * 3_600_000 })).toMatchObject({ durationMs: DUREE_MAX_MS });
    expect(validerEvenement({ type: "LEAVE", path: "/", durationMs: -5 })).toBeNull();
    expect(validerEvenement({ type: "LEAVE", path: "/" })).toBeNull();
  });
  it("une session : un identifiant court et propre, sinon rien", () => {
    expect(validerEvenement({ type: "PAGEVIEW", path: "/", session: "abcdef0123456789" })!.session).toBe("abcdef0123456789");
    expect(validerEvenement({ type: "PAGEVIEW", path: "/", session: "<script>" })!.session).toBeNull();
  });
  it("le lot : au plus 50, les invalides écartés", () => {
    const lot = Array.from({ length: 80 }, (_, i) => ({ type: i % 2 ? "PAGEVIEW" : "BOGUS", path: "/" }));
    expect(validerLot({ events: lot }).length).toBe(LOT_MAX / 2);
    expect(validerLot([{ type: "PAGEVIEW", path: "/" }]).length).toBe(1);
    expect(validerLot({ autre: 1 })).toEqual([]);
    expect(normaliserChemin("/blog/")).toBe("/blog");
    expect(normaliserChemin("/")).toBe("/");
  });
  it("le pays vient des en-têtes de l'hébergeur, sinon rien", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n] ?? null;
    expect(paysDepuisEntetes(h({ "cf-ipcountry": "dz" }))).toBe("DZ");
    expect(paysDepuisEntetes(h({ "x-vercel-ip-country": "FR" }))).toBe("FR");
    expect(paysDepuisEntetes(h({ "cf-ipcountry": "XX" }))).toBeNull();
    expect(paysDepuisEntetes(h({}))).toBeNull();
    expect(nomDuPays("DZ")).toMatch(/Alg/);
    expect(nomDuPays("Inconnu")).toBe("Inconnu");
  });
});

describe("L'entonnoir par offre que le site marque", () => {
  it("un nom long `postuler-<poste>-envoyer` arrive ENTIER (l'envoi ne se confond pas avec le clic)", () => {
    const poste = "responsable-affaires-reglementaires-alger";
    expect(validerEvenement({ type: "CLICK", path: `/carrieres/${poste}`, label: `postuler-${poste}-envoyer` }))
      .toMatchObject({ label: `postuler-${poste}-envoyer` });
    expect(validerEvenement({ type: "CLICK", path: "/", label: `x${"a".repeat(80)}` })).toMatchObject({ label: "cta" });
    expect(scriptAudience("https://erp.test/api/site-web/v1/audience")).toContain(".slice(0, 80)");
  });
  it("des libellés lisibles à l'écran", () => {
    expect(libelleClic("postuler")).toBe("Postuler");
    expect(libelleClic("postuler-delegue-alger")).toBe("Postuler — delegue-alger");
    expect(libelleClic("postuler-delegue-alger-envoyer")).toBe("Candidature envoyée — delegue-alger");
    expect(libelleClic("devenir-partenaire")).toBe("devenir-partenaire");
  });
});

describe("Les périodes", () => {
  // Mardi 7 octobre 2026, 10 h 30 à Alger (9 h 30 UTC).
  const maintenant = new Date("2026-10-07T09:30:00Z");

  it("« 7 j » commence à minuit (Alger) six jours plus tôt ; la précédente a la même durée écoulée", () => {
    const b = bornesPeriode("7j", maintenant);
    expect(b.debut.toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(b.debutPrecedent.toISOString()).toBe("2026-09-23T23:00:00.000Z");
    expect(b.finPrecedent.getTime() - b.debutPrecedent.getTime()).toBe(b.fin.getTime() - b.debut.getTime());
    const seaux = seauxDeLaPeriode(b);
    expect(seaux).toHaveLength(7);
    expect(seaux[0]).toBe("2026-10-01");
    expect(seaux[6]).toBe("2026-10-07");
    expect(cleDeSeau(maintenant, "jour")).toBe("2026-10-07");
    // 23 h 30 UTC le 30/09 = 0 h 30 le 1er octobre à Alger.
    expect(cleDeSeau(new Date("2026-09-30T23:30:00Z"), "jour")).toBe("2026-10-01");
  });

  it("« 12 mois » : le mois en cours et les onze d'avant", () => {
    const b = bornesPeriode("12m", maintenant);
    expect(b.granularite).toBe("mois");
    const seaux = seauxDeLaPeriode(b);
    expect(seaux).toHaveLength(12);
    expect(seaux[0]).toBe("2025-11");
    expect(seaux[11]).toBe("2026-10");
    expect(b.finPrecedent.getTime()).toBeLessThanOrEqual(b.debut.getTime());
    expect(libelleDeSeau("2026-10")).toBe("oct. 26");
    expect(libelleDeSeau("2026-10-07")).toBe("07/10");
  });

  it("le paramètre d'URL : une période connue, sinon 30 j", () => {
    expect(lirePeriode("90j")).toBe("90j");
    expect(lirePeriode(["12m"])).toBe("12m");
    expect(lirePeriode("1an")).toBe("30j");
    expect(lirePeriode(undefined)).toBe("30j");
  });

  it("la série est complète : un jour sans visite est un zéro", () => {
    const s = serieComplete(["a", "b", "c"], [{ seau: "b", v: 4 }], (seau) => ({ seau, v: 0 }));
    expect(s).toEqual([{ seau: "a", v: 0 }, { seau: "b", v: 4 }, { seau: "c", v: 0 }]);
  });
});

describe("Les calculs de l'écran", () => {
  it("variation en %, rien quand la période précédente était vide", () => {
    expect(variation(120, 100)).toEqual({ valeur: 20, texte: "+20 %", favorable: true });
    expect(variation(80, 100)).toMatchObject({ valeur: -20, texte: "−20 %", favorable: false });
    expect(variation(10, 0)).toEqual({ valeur: null, texte: null, favorable: null });
    expect(variation(100, 100).favorable).toBeNull();
  });
  it("un taux s'écarte en points, et le rebond qui monte est une mauvaise nouvelle", () => {
    expect(ecartPoints(42, 40, false)).toMatchObject({ valeur: 2, favorable: false });
    expect(ecartPoints(3.25, 2, true)).toMatchObject({ texte: "+1,3 pt", favorable: true });
    expect(ecartPoints(null, 2)).toMatchObject({ valeur: null });
  });
  it("rebond et conversion", () => {
    expect(tauxDeRebond(30, 120)).toBe(25);
    expect(tauxDeRebond(0, 0)).toBeNull();
    expect(taux(3, 150)).toBe(2);
  });
  it("durées et âges lisibles", () => {
    expect(formatDuree(42_000)).toBe("42 s");
    expect(formatDuree(84_000)).toBe("1 min 24 s");
    expect(formatDuree(0)).toBe("—");
    expect(formatDuree(null)).toBe("—");
    const t = new Date("2026-10-07T10:00:00Z");
    expect(ilYA(new Date(t.getTime() - 30_000), t)).toBe("il y a moins d'une minute");
    expect(ilYA(new Date(t.getTime() - 5 * 60_000), t)).toBe("il y a 5 min");
    expect(ilYA(new Date(t.getTime() - 3 * 3_600_000), t)).toBe("il y a 3 h");
    expect(ilYA(new Date(t.getTime() - 4 * 86_400_000), t)).toBe("il y a 4 j");
  });
  it("le slug d'une offre ou d'un article, depuis la page ou l'adresse rendue par le site", () => {
    expect(slugSous("/carrieres/delegue-medical-alger", "carrieres")).toBe("delegue-medical-alger");
    expect(slugSous("/carrieres/delegue-medical-alger/postuler", "carrieres")).toBe("delegue-medical-alger");
    expect(slugSous("/fr/blog/Pharmacovigilance", "blog")).toBe("pharmacovigilance");
    expect(slugSous("/carrieres", "carrieres")).toBeNull();
    expect(slugSous("/blog/x", "carrieres")).toBeNull();
    expect(slugDeLAdresse("https://adventumdz.com/carrieres/kam-oran", "carrieres")).toBe("kam-oran");
    expect(slugDeLAdresse(null, "blog")).toBeNull();
  });
});

describe("Le script du site", () => {
  const s = scriptAudience("https://erp.test/api/site-web/v1/audience");
  it("léger, sans cookie ni stockage persistant, respecte « ne pas me suivre »", () => {
    expect(s.length).toBeLessThan(6 * 1024);
    expect(s).not.toMatch(/document\.cookie|localStorage/);
    expect(s).toContain("sessionStorage");
    expect(s).toContain('n.doNotTrack === "1"');
    expect(s).toContain("sendBeacon");
    expect(s).toContain("data-adventum-track");
    expect(s).toContain('credentials: "omit"');
    for (const l of ["postuler", "telephone", "email", "whatsapp", "telechargement", "externe"]) expect(s).toContain(`"${l}"`);
  });
  it("est du JavaScript valide (il se compile)", () => {
    expect(() => new Function(s)).not.toThrow();
  });
});
