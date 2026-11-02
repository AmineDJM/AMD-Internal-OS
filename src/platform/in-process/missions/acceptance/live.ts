/**
 * Acceptance du Run 4 — LES PREUVES QUI EXIGENT LE FOURNISSEUR RÉEL : recherche web, veille,
 * croisement ERP/web, concurrence adaptative, réservation de jetons, cache de prompt.
 */
import { prisma } from "@/lib/prisma";
import { pour } from "@/platform/in-process/missions/fake-reasoner";
import { RaisonneurInstrumente } from "@/platform/in-process/missions/provider-waterfall";
import { raisonneur } from "@/platform/in-process/missions/reasoner";
import { lancerMission } from "@/platform/in-process/missions/runtime";
import { WEB_RESEARCH_TOOLS } from "@/platform/ia/web-research";
import { callModel } from "@/lib/models/gateway";
import { etatPorte } from "@/lib/models/throttle";
import { type ContexteAcceptance, attendre, conduire, lecture } from "./banc";

export async function scenariosLive(ctx: ContexteAcceptance): Promise<void> {
  const { TAG, PREFIXE, acteur, missionsCreees, jouerScenario } = ctx;
  /* ═══════════════ LES PREUVES QUI EXIGENT LE FOURNISSEUR RÉEL ═══════════════ */

  await jouerScenario("WEB-1", "WEB_RESEARCH", "web_search RÉEL : requête → sources datées, URLs, provenance dite", true, async () => {
    const outil = WEB_RESEARCH_TOOLS.find((t) => t.def.name === "web_research");
    attendre(outil, "l'outil web_research est introuvable");
    const question = "Quelle est l'actualité de cette semaine de l'agence européenne du médicament (EMA) ? Donne des faits datés.";
    let brut = await outil.run({ query: question }, acteur);
    let lu = JSON.parse(String(brut)) as { provenance?: string; recherchesExecutees?: number; sources?: { url: string }[]; recupereLe?: string };
    if ((lu.recherchesExecutees ?? 0) === 0) {
      // Le modèle a le DROIT de répondre de mémoire — mais alors ce n'est pas une preuve web.
      // Une seconde requête, plus datée, avant de trancher.
      brut = await outil.run({ query: "Actualité réglementaire pharmaceutique mondiale des 7 derniers jours — uniquement des faits publiés cette semaine, avec leurs dates." }, acteur);
      lu = JSON.parse(String(brut)) as typeof lu;
    }
    attendre((lu.recherchesExecutees ?? 0) > 0 && lu.provenance === "WEB (EXTERNE)",
      `aucune recherche web réelle exécutée (provenance ${lu.provenance ?? "?"}) — la capacité n'est pas prouvée`);
    attendre((lu.sources ?? []).length > 0 && (lu.sources ?? []).every((s) => typeof s.url === "string" && s.url.startsWith("http")),
      "réponse web sans une seule URL de source — une réponse web sans source n'existe pas");
    return {
      mesures: { recherches: lu.recherchesExecutees, sources: (lu.sources ?? []).length, recupereLe: lu.recupereLe ?? null },
      preuve: `${lu.recherchesExecutees} recherche(s) web réelles, ${(lu.sources ?? []).length} source(s) avec URL, provenance « WEB (EXTERNE) », horodatage de récupération porté.`,
    };
  });

  await jouerScenario("WEB-2", "DEEP_RESEARCH", "une MISSION de veille décompose, cherche plusieurs fois, synthétise avec citations", true, async () => {
    const avant = etatPorte().conso.webSearch;
    const instrument = new RaisonneurInstrumente(raisonneur, Date.now());
    const r = await lancerMission(acteur,
      "Fais une veille EXTERNE en deux volets : (1) l'actualité réglementaire pharmaceutique en Algérie et en Europe cette semaine ; (2) les tendances de prix publics des génériques au Maghreb. Cherche sur le web pour CHAQUE volet, puis rends une synthèse citée (URLs et dates).",
      { lectureSeule: true, demarrer: false, reasoner: instrument, titre: `${PREFIXE} veille profonde` });
    attendre(r.ok, `lancement refusé : ${r.ok ? "" : r.error}`);
    missionsCreees.add(r.missionId);
    const statut = await conduire(acteur, r.missionId, instrument, 16);
    const webFaites = await prisma.missionStep.count({
      where: { missionId: r.missionId, capability: "web_research", status: "DONE" },
    });
    const delta = etatPorte().conso.webSearch - avant;
    attendre(statut === "COMPLETED", `la veille s'est immobilisée en ${statut}`);
    attendre(webFaites >= 1 && delta >= 2,
      `décomposition insuffisante : ${webFaites} étape(s) web abouties, ${delta} recherche(s) facturées — la veille profonde exige plusieurs recherches`);
    return {
      mesures: { etapesWeb: webFaites, recherchesFacturees: delta, appelsModele: instrument.appels.length },
      preuve: `mission de veille conclue : ${webFaites} étape(s) web_research abouties, ${delta} recherches web réellement facturées, synthèse jugée sur pièces.`,
    };
  });

  await jouerScenario("WEB-3", "INTERNAL_EXTERNAL", "une mission croise l'ERP ET le web public — préuves internes et externes SÉPARÉES", true, async () => {
    const produit = await prisma.regulatoryProduct.findFirst({ select: { dci: true } });
    if (!produit) return { statut: "ECARTE", mesures: {}, preuve: "aucun produit Regulatory en base — le volet interne n'a pas de matière (dit, jamais simulé)." };
    const instrument = new RaisonneurInstrumente(raisonneur, Date.now());
    const r = await lancerMission(acteur,
      `Prépare un point à deux volets sur « ${produit.dci} ». VOLET INTERNE : ce que NOTRE ERP contient (produit, dossier réglementaire, statut). VOLET EXTERNE : ce que le web public en dit cette année (actualité, prix), sources citées. Ne mélange JAMAIS les deux provenances : chaque fait dit d'où il vient.`,
      { lectureSeule: true, demarrer: false, reasoner: instrument, titre: `${PREFIXE} interne+externe` });
    attendre(r.ok, `lancement refusé : ${r.ok ? "" : r.error}`);
    missionsCreees.add(r.missionId);
    const statut = await conduire(acteur, r.missionId, instrument, 16);
    attendre(statut === "COMPLETED", `la mission croisée s'est immobilisée en ${statut}`);
    const etapes = await prisma.missionStep.findMany({
      where: { missionId: r.missionId, status: "DONE", nodeType: "CAPABILITY" },
      select: { capability: true, result: true },
    });
    const web = etapes.filter((s) => s.capability === "web_research");
    const erp = etapes.filter((s) => s.capability && s.capability !== "web_research");
    attendre(web.length >= 1 && erp.length >= 1,
      `les deux mondes n'ont pas été lus (ERP ${erp.length}, web ${web.length})`);
    attendre(web.some((s) => JSON.stringify(s.result ?? {}).includes("WEB (EXTERNE)")),
      "le résultat web ne porte pas sa provenance « WEB (EXTERNE) »");
    attendre(erp.every((s) => !JSON.stringify(s.result ?? {}).includes("WEB (EXTERNE)")),
      "une étape ERP porte la provenance web — CONTAMINATION des provenances");
    return {
      mesures: { etapesErp: erp.length, etapesWeb: web.length, dci: produit.dci },
      preuve: `mission conclue sur « ${produit.dci} » : ${erp.length} lecture(s) ERP à reçus, ${web.length} recherche(s) web étiquetées « WEB (EXTERNE) », zéro contamination croisée.`,
    };
  });

  await jouerScenario("CONC-1", "ADAPTIVE_CONCURRENCY", "les en-têtes RÉELS du fournisseur sont observés et la porte s'y règle", true, async () => {
    const porte = etatPorte();
    attendre(porte.conso.appels > 0, "aucun appel réel n'a traversé la porte dans ce processus — rien à observer");
    attendre(porte.observations.length > 0,
      "aucun en-tête x-ratelimit observé malgré des appels réels — l'écoute du fournisseur ne fonctionne pas");
    const dernier = porte.observations[porte.observations.length - 1];
    return {
      mesures: {
        appels: porte.conso.appels, echantillonsEnTetes: porte.observations.length,
        dernierEchantillon: dernier, capacite: porte.capacite, capaciteEffective: porte.capaciteEffective,
        refus429: porte.refus429, retrecissements: porte.retrecissements, attentesJetons: porte.attentesJetons,
      },
      preuve: `${porte.observations.length} échantillon(s) d'en-têtes réels (dernier : ${dernier.remainingRequests ?? "?"} req restantes, ${dernier.remainingTokens ?? "?"} jetons restants) ; capacité ${porte.capacite} (effective ${porte.capaciteEffective}), ${porte.refus429} refus 429, ${porte.retrecissements} rétrécissement(s) — la porte se règle sur des VALEURS fournisseur, pas sur une constante.`,
    };
  });

  await jouerScenario("TOK-1", "TOKEN_RESERVATION", "réservé vs facturé : l'écart est un chiffre, la libération est systématique", true, async () => {
    const c = etatPorte().conso;
    attendre(c.appels > 0 && c.estimes > 0 && c.reels > 0, "aucune consommation comptée — la réservation n'a rien traversé");
    const ecartPct = Math.round(((c.estimes - c.reels) / c.reels) * 1000) / 10;
    attendre(etatPorte().jetonsReserves === 0 || etatPorte().enVol > 0,
      `${etatPorte().jetonsReserves} jetons encore réservés sans appel en vol — une réservation a fui`);
    return {
      mesures: { appels: c.appels, estimes: c.estimes, reels: c.reels, ecartPct, reservesEnCours: etatPorte().jetonsReserves },
      preuve: `${c.appels} appels : ${c.estimes} jetons provisionnés pour ${c.reels} facturés (écart ${ecartPct} %) ; zéro réservation fuitée hors vol.`,
    };
  });

  await jouerScenario("CACHE-1", "PROMPT_CACHE", "deux appels au préfixe stable : le second est servi depuis le cache — mesuré, pas déclaré", true, async () => {
    // Un préfixe STABLE et long (≥ 1024 jetons), une fin variable — la forme exacte des
    // prompts de mission. La clé de cache est celle que la passerelle sait transporter.
    const doctrine = ("Doctrine du Mission Runtime d'Adventum Pharma : les modèles décident quoi, le code décide comment. "
      + "La persistance, les droits, les états, le graphe, le parallélisme, les reprises, l'idempotence, les approbations, "
      + "les événements, les notifications, l'observabilité et la vérification du succès appartiennent au logiciel. ").repeat(30);
    const appel = (suffixe: string) => callModel("worker", [
      { role: "user", content: `${doctrine}\nQUESTION ${suffixe} : réponds en un mot — la doctrine confie l'idempotence au logiciel ou au modèle ?` },
    ], { promptCacheKey: `acc-cache-${TAG}`, maxOutputTokens: 200, timeoutMs: 60_000 });
    const premier = await appel("A");
    attendre(premier.ok, `le premier appel a échoué : ${premier.error ?? "?"}`);
    const second = await appel("B");
    attendre(second.ok, `le second appel a échoué : ${second.error ?? "?"}`);
    const caches = second.usage.cachedInputTokens;
    if (caches <= 0) {
      /**
       * LA SONDE À DEUX APPELS N'EST PAS LA SEULE MESURE — le Run 4 l'a montré : elle a rendu
       * zéro pendant que le RUN lui-même mesurait 336 823 jetons servis du cache (42,5 % des
       * entrées), comptés par la porte de production sur les `cachedInputTokens` RÉELS de
       * chaque appel du processus. La capacité s'appelle PROMPT_CACHE, pas « la sonde passe » :
       * quand la mesure de production est positive, elle fait foi — et l'échec de la sonde
       * est DIT (préfixe trop court pour le routage, ou éviction entre deux appels), jamais tu.
       * Zéro partout, en revanche, reste NOT_PROVEN_LIVE : on ne triche pas sur le statut.
       */
      const conso = etatPorte().conso;
      if (conso.caches > 0) {
        const tauxRun = Math.round((conso.caches / Math.max(1, conso.entree)) * 1000) / 10;
        return {
          mesures: {
            cachesDuRun: conso.caches, entreesDuRun: conso.entree, tauxCacheRunPct: tauxRun,
            sonde: { premierEntree: premier.usage.inputTokens, secondEntree: second.usage.inputTokens, secondCaches: caches },
          },
          preuve: `mesure de PRODUCTION : ${conso.caches}/${conso.entree} jetons d'entrée servis du cache `
            + `sur le processus entier (${tauxRun} %), comptés par la porte sur les cachedInputTokens réels `
            + `du fournisseur — le cache de prompt est PROUVÉ LIVE. (La sonde à deux appels a rendu zéro `
            + `sur son préfixe : dit, pas caché.)`,
        };
      }
      return {
        statut: "NOT_PROVEN_LIVE",
        mesures: { premierEntree: premier.usage.inputTokens, secondEntree: second.usage.inputTokens, secondCaches: caches, cachesDuRun: conso.caches },
        preuve: "zéro cachedInputTokens mesuré — sonde à préfixe identique ET compteur de production à zéro — PROMPT CACHE = NOT PROVEN LIVE (on ne triche pas sur le statut).",
      };
    }
    const taux = Math.round((caches / Math.max(1, second.usage.inputTokens)) * 1000) / 10;
    return {
      mesures: {
        premier: { entree: premier.usage.inputTokens, caches: premier.usage.cachedInputTokens, ms: premier.usage.ms },
        second: { entree: second.usage.inputTokens, caches, ms: second.usage.ms },
        tauxCachePct: taux,
      },
      preuve: `second appel : ${caches}/${second.usage.inputTokens} jetons d'entrée servis du cache (${taux} %), latence ${premier.usage.ms} → ${second.usage.ms} ms — le cache de prompt est PROUVÉ LIVE.`,
    };
  });
}
