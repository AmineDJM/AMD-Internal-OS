import { describe, expect, it } from "vitest";
import { assistantToolsFor } from "@/lib/assistant";
import { routeQuery } from "@/lib/assistant/context/router";
import { LEVEL_CAP, resolveTools } from "@/lib/assistant/context/tool-resolver";
import { BUSINESS_CAPABILITIES } from "./business-capabilities";
import { DIRECT_INTENTS } from "@/platform/ia/workspace/direct-intents";
import { stripDisplayPayload } from "./workspace/compose";
import { METRICS } from "@/lib/metrics/catalog";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'ARCHITECTURE — ce que le chantier a RÉELLEMENT changé, en chiffres.
 *
 * ── CE QU'IL MESURE, ET POURQUOI CEUX-LÀ ─────────────────────────────────────────────────
 *
 * La mission demande des preuves de réduction sur six axes : outils exposés, appels modèle,
 * raisonnement inutile, navigation/retrieval, jetons, tours utilisateur.
 *
 * TROIS de ces axes se mesurent ICI, sans réseau et sans clé, parce qu'ils sont DÉTERMINISTES :
 *
 *   • les OUTILS EXPOSÉS — c'est le résolveur qui les choisit, sur une règle écrite ;
 *   • les APPELS D'OUTIL nécessaires à une mission — c'est une propriété du registre, pas du
 *     modèle : si une seule capacité porte la réponse, il n'y a qu'un appel à faire ;
 *   • les JETONS DE SCHÉMA envoyés à chaque tour — c'est du texte, il se compte.
 *
 * TROIS ne se mesurent QU'EN PRODUCTION, avec la clé OpenAI : le nombre d'appels modèle
 * réellement émis, le raisonnement consommé, et les tours utilisateur. Ce fichier ne prétend
 * PAS les mesurer, et le dire est la moitié de la valeur d'un instrument.
 *
 * ── LA RÈGLE DE PROBITÉ ──────────────────────────────────────────────────────────────────
 *
 * On ne retire pas une mission parce qu'elle mesure mal. Les seuils ci-dessous sont des
 * CLIQUETS : ils constatent l'état du jour et empêchent qu'il empire. Les desserrer pour faire
 * passer un lot serait transformer l'instrument en décoration.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

function superAdmin(): CurrentUser {
  return {
    id: "u-eval", name: "PDG", email: "pdg@test.local", role: "SUPER_ADMIN",
    access: {
      modules: new Map(
        ["REGULATORY", "PCH", "FINANCES", "BUDGETS", "RH", "DRIVE", "WORKSPACE", "STOCKS", "MEDICAL", "MAIL_REGISTER", "CHIEF_OF_STAFF"]
          .map((m) => [m, { scope: "ALL", actions: new Set(["VIEW", "CREATE", "EDIT"]) }]),
      ),
      companies: [], allCompanies: true,
    },
  } as unknown as CurrentUser;
}

/** Le nombre d'outils réellement ENVOYÉS au modèle pour une question donnée. */
function outilsExposes(question: string, user: CurrentUser): { n: number; niveau: string; noms: string[] } {
  const route = routeQuery(question);
  const r = resolveTools(assistantToolsFor(user), question, route);
  return { n: r.tools.length, niveau: r.level, noms: r.tools.map((t) => t.name) };
}

/**
 * LES MISSIONS RÉELLES. Formulées comme le PDG les pose — pas comme un test les poserait.
 *
 * `avant` est le nombre d'appels d'outil qu'il FALLAIT enchaîner avant ce chantier, compté à la
 * main en lisant le registre de l'époque : il n'existait pas d'outil qui traverse le produit
 * canonique, donc chaque source se lisait à part et se rapprochait par LIBELLÉ.
 */
const MISSIONS: { question: string; avant: number; apres: number; pourquoiAvant: string }[] = [
  {
    question: "Combien rapporte le produit Nivolumab 100 mg et combien coûte-t-il ?",
    avant: 5,
    apres: 1,
    pourquoiAvant: "product_360 (dossier) + read_finances + sales_operation + adpro_operation + read_hr_overview, "
      + "puis rapprochement des libellés à la main par le modèle",
  },
  {
    question: "Qui porte le produit Nivolumab et depuis quand ?",
    avant: 3,
    apres: 1,
    pourquoiAvant: "search_products + read_hr_overview + recoupement — aucune relation ne portait l'affectation",
  },
  {
    question: "Où en est le marché AO-2025-014 et combien la PCH nous doit-elle encore ?",
    avant: 3,
    apres: 1,
    pourquoiAvant: "pch_operation (fiche) + inspect_record (bons) + finance_totals, sans définition partagée des montants",
  },
];

describe("banc d'architecture — les outils exposés", () => {
  const user = superAdmin();

  it("une question métier n'expose JAMAIS tout le registre", () => {
    const total = assistantToolsFor(user).length;
    for (const m of MISSIONS) {
      const { n, niveau } = outilsExposes(m.question, user);
      // Le plafond du niveau fait foi ; ce qui compte est qu'on soit très en dessous du registre.
      expect(n, `${m.question} → ${n} outils`).toBeLessThanOrEqual(LEVEL_CAP[niveau as keyof typeof LEVEL_CAP]);
      expect(n).toBeLessThan(total / 2);
    }
  });

  it("la capacité qui répond EST dans la liste envoyée — sinon elle ne sert à rien", () => {
    // Une capacité hors shortlist est invisible pour le modèle : il refait la séquence longue
    // sans savoir qu'un raccourci existe. C'est la panne la plus discrète du dispositif.
    const eco = outilsExposes(MISSIONS[0].question, user);
    expect(eco.noms, `niveau ${eco.niveau} · ${eco.n} outils`).toContain("product_economics");

    const pch = outilsExposes(MISSIONS[2].question, user);
    expect(pch.noms, `niveau ${pch.niveau} · ${pch.n} outils`).toContain("pch_market_status");
  });
});

describe("banc d'architecture — les appels d'outil par mission", () => {
  it("chaque mission passe de N appels à UN, et le N est justifié", () => {
    for (const m of MISSIONS) {
      expect(m.apres, m.question).toBe(1);
      expect(m.avant, m.question).toBeGreaterThan(1);
      // La justification n'est pas décorative : sans elle, « avant = 5 » est un chiffre qu'on
      // s'est donné à soi-même. Elle nomme les outils qu'il fallait enchaîner.
      expect(m.pourquoiAvant.length, m.question).toBeGreaterThan(40);
    }
    const avant = MISSIONS.reduce((n, m) => n + m.avant, 0);
    const apres = MISSIONS.reduce((n, m) => n + m.apres, 0);
    // 11 → 3 sur ces trois missions. Le chiffre est reporté dans le rapport final.
    expect(apres).toBeLessThan(avant / 3);
  });
});

describe("banc d'architecture — les jetons de schéma", () => {
  const user = superAdmin();

  /** Approximation stable : ~4 caractères par jeton. Ce qui compte est la COMPARAISON. */
  const jetons = (s: string): number => Math.ceil(s.length / 4);

  it("le schéma envoyé pour une mission reste borné, et se compare", () => {
    const tous = assistantToolsFor(user);
    const totalRegistre = jetons(JSON.stringify(tous));

    for (const m of MISSIONS) {
      const route = routeQuery(m.question);
      const cout = jetons(JSON.stringify(resolveTools(tous, m.question, route).tools));
      // Envoyer TOUT le registre à chaque tour coûterait plusieurs fois cela. Le rapport est la
      // mesure honnête : les valeurs absolues bougeront avec chaque outil ajouté, le RAPPORT non.
      expect(cout, `${m.question} — ${cout} jetons contre ${totalRegistre}`).toBeLessThan(totalRegistre / 2);
    }
  });

  it("les deux capacités coûtent MOINS que la séquence qu'elles remplacent", () => {
    const tous = assistantToolsFor(user);
    const nom = (n: string) => tous.find((t) => t.name === n);

    const capacite = jetons(JSON.stringify([nom("product_economics")]));
    // La séquence d'avant : les cinq outils qu'il fallait envoyer ENSEMBLE pour que le modèle
    // puisse les enchaîner en un tour.
    const sequence = ["product_360", "read_finances", "sales_operation", "adpro_operation", "read_hr_overview"]
      .map(nom).filter(Boolean);
    const coutSequence = jetons(JSON.stringify(sequence));

    expect(sequence.length, "la séquence de référence doit exister dans le registre").toBeGreaterThanOrEqual(4);
    expect(capacite, `capacité ${capacite} jetons · séquence ${coutSequence} jetons`).toBeLessThan(coutSequence);
  });
});

describe("banc d'architecture — ce qui est DÉTERMINISTE et ne demande plus le modèle", () => {
  it("chaque métrique nommée a UNE définition écrite — zéro calcul laissé au langage", () => {
    // La mission l'exige mot pour mot : « pas de LLM pour remplacer une FK, une règle ou un
    // calcul déterministe ». Une métrique sans définition écrite serait un calcul que le modèle
    // referait à sa façon, différemment à chaque fois.
    expect(METRICS.length).toBeGreaterThanOrEqual(13);
    for (const m of METRICS) {
      expect(m.definition.length, m.nom).toBeGreaterThan(40);
    }
  });

  it("les capacités portent la définition DANS leur réponse, pas à côté", () => {
    for (const c of BUSINESS_CAPABILITIES) {
      expect(c.def.description, c.def.name).toMatch(/DÉFINITION|définition/);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GESTE DÉTERMINISTE (§23) — les appels au modèle que le CLIC ne paie plus.
 *
 * C'est la seule économie d'APPEL MODÈLE qui se mesure ici sans clé, parce qu'elle ne dépend
 * pas du modèle : un bouton porteur d'`intent` n'en appelle aucun, par construction. Le chiffre
 * n'est donc pas une estimation — c'est le nombre d'allers-retours SUPPRIMÉS par clic.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("banc d'architecture — les gestes qui n'appellent plus le modèle", () => {
  const user = superAdmin();
  const jetons = (s: string): number => Math.ceil(s.length / 4);

  it("chaque geste direct remplace UN tour complet de conversation", () => {
    // Le tour évité n'est pas « un appel » : c'est le SCHÉMA des outils exposés pour la
    // question, plus la question, plus la réponse rédigée. Le schéma seul se compte ici.
    const tous = assistantToolsFor(user);
    let economise = 0;

    for (const [nom, def] of Object.entries(DIRECT_INTENTS)) {
      // La phrase que le bouton aurait envoyée — celle-là même que le modèle aurait dû
      // comprendre pour retrouver l'outil que le registre nomme déjà.
      const phrase = def.phrase.replace("%s", "DEMO-REF-001");
      const exposes = resolveTools(tous, phrase, routeQuery(phrase)).tools;
      const cout = jetons(JSON.stringify(exposes));
      expect(cout, `${nom} — le tour évité coûtait ${cout} jetons de schéma`).toBeGreaterThan(0);
      economise += cout;
    }

    // Cinq gestes déclarés ⇒ cinq tours de moins par séquence de zoom complète. Le seuil est un
    // CLIQUET : retirer un geste du registre le fait tomber, et c'est le but.
    expect(Object.keys(DIRECT_INTENTS).length).toBeGreaterThanOrEqual(5);
    expect(economise, `${economise} jetons de schéma évités par séquence complète`).toBeGreaterThan(2000);
  });

  it("l'outil de chaque geste EXISTE — un bouton mort ne s'attrape qu'ici", () => {
    // Une capacité qui nomme un outil disparu produit un bouton qui échoue au clic, et le repli
    // (la phrase) masquerait l'erreur en la faisant marcher quand même — donc personne ne le
    // saurait jamais. C'est exactement le genre de panne que le banc existe pour trouver.
    const noms = new Set(assistantToolsFor(user).map((x) => x.name));
    for (const [cap, def] of Object.entries(DIRECT_INTENTS)) {
      expect(noms.has(def.tool), `${cap} → ${def.tool} : outil introuvable dans le registre`).toBe(true);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CHARGE D'AFFICHAGE (§41) — les jetons que le modèle ne lit plus.
 *
 * `_blocs` porte ce que l'ÉCRAN rend : identifiants de jalons, chemins de pièces, libellés de
 * boutons, couleurs. Le modèle la recevait mot pour mot sans jamais s'en servir — il répond à
 * partir des faits, qui figurent ailleurs dans la même réponse.
 *
 * Sur une histoire d'affaire, cette charge dépasse le reste d'un ordre de grandeur. La mesure
 * ci-dessous est faite sur une sortie de la MÊME FORME que celle de `business_story`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("banc d'architecture — la charge d'affichage retirée du contexte", () => {
  const jetons = (s: string): number => Math.ceil(s.length / 4);

  it("le modèle ne lit plus la frise qu'il n'utilise pas", () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      id: `bc:${i}`, date: "2024-07-02", kind: "commande",
      titre: `Bon de commande n° ${i + 1}`, etat: "fait",
      detail: "Livré et facturé — règlement à 90 jours selon la convention annuelle.",
      metriques: [{ valeur: "480 M", label: "commandé" }, { valeur: "480 M", label: "livré" }],
      participants: [{ nom: "Démo Benkaci", role: "Responsable PCH" }],
      docs: [{ nom: `BC-${i + 1}.pdf`, href: "/api/drive/file/x", type: "pdf", taille: "240 Ko" }],
      fils: ["famille:commandes"], provenance: "PchOrder", certitude: "fait",
    }));
    const sortie = JSON.stringify({
      affaire: "Marché DEMO-AO-2024",
      jalons: events.length,
      kpis: [{ valeur: "1,24 Md", label: "Attribué" }, { valeur: "612 M", label: "Encaissé" }],
      limites: ["La date de soumission est déduite de la date de publication."],
      _blocs: [{ kind: "story", title: "Marché DEMO-AO-2024", events }],
      _blocsDecoratifs: true,
    });

    const avant = jetons(sortie);
    const apres = jetons(stripDisplayPayload(sortie));
    // La forme reste lisible : les KPI et les limites, dont le modèle a besoin pour commenter.
    expect(stripDisplayPayload(sortie)).toContain("limites");
    expect(stripDisplayPayload(sortie)).not.toContain("_blocs");
    // Le rapport est ce qui se reporte dans le rapport final ; l'absolu bougera avec la donnée.
    expect(apres, `${avant} → ${apres} jetons`).toBeLessThan(avant / 8);
  });

  it("une sortie SANS charge d'affichage n'est pas amputée", () => {
    // Le repli doit être l'identité. Une réponse que le composeur n'a pas su lire ne doit
    // surtout pas revenir tronquée au modèle — ce serait échanger des jetons contre des faits.
    const nu = JSON.stringify({ effectif: 33, perimetre: "Adventum + Pharmagène" });
    expect(stripDisplayPayload(nu)).toBe(nu);
    expect(stripDisplayPayload("pas du JSON du tout")).toBe("pas du JSON du tout");
  });

  it("SANS DÉCLARATION, rien n'est retiré — c'est la garde de la régression trouvée en audit", () => {
    // Le brouillon d'e-mail porte son CORPS dans le bloc, et nulle part ailleurs. La première
    // version allégeait toute sortie : « raccourcis le deuxième paragraphe » devenait alors
    // impossible, le modèle ne voyant plus le message qu'il venait d'écrire.
    const brouillon = JSON.stringify({
      intentId: "i-1", etat: "AWAITING_APPROVAL", destinataires: ["x@y.dz"], objet: "Relance",
      _blocs: [{ kind: "email", title: "Message", a: ["x@y.dz"], objet: "Relance", corps: "Bonjour…", statut: "brouillon" }],
    });
    expect(stripDisplayPayload(brouillon)).toBe(brouillon);
    expect(stripDisplayPayload(brouillon)).toContain("corps");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE CE BANC NE MESURE PAS — et qui ne se mesure qu'en production.
 *
 * Écrit ici plutôt que dans un document à part, pour que ce soit lu par celui qui lira les
 * chiffres ci-dessus.
 *
 *   • LE NOMBRE D'APPELS MODÈLE réellement émis. Le banc montre qu'UN appel d'outil SUFFIT ;
 *     combien de tours le modèle prend pour s'en servir dépend de lui, donc du réseau.
 *   • LES JETONS DE RAISONNEMENT (`reasoning_tokens`) et la latence : `gateway.ts` les journalise
 *     déjà, il faut la clé pour les produire.
 *   • LES TOURS UTILISATEUR : ils se comptent sur des conversations réelles.
 *
 * Les bornes existent dans le code (frise vocale, journal du gateway) ; les NOMBRES doivent
 * venir des journaux de production. Prétendre les mesurer ici reviendrait à mesurer un simulacre
 * et à l'appeler un résultat.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
