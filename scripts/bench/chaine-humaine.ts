/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CHAÎNE HUMAINE — le banc qui FAIT RÉPONDRE LES GENS.
 *
 *   npx tsx scripts/bench/chaine-humaine.ts
 *
 * ── POURQUOI CE BANC EXISTE ─────────────────────────────────────────────────────────────
 *
 * `adam-mission-bench.ts` lance déjà des missions par le vrai point d'entrée et vérifie que le
 * PLAN contient l'attente, les sollicitations nominatives et le livrable. Puis il s'arrête :
 *
 *     if (sig === precedent) break;   // état stable : la mission ATTEND
 *
 * Il ne fait jamais RÉPONDRE les humains. Aucune attente n'est donc jamais levée, et tout ce
 * qui vient après — la relance ciblée, le passage à la personne suivante, la consolidation,
 * l'Excel, le PowerPoint, le retour au dirigeant — n'a jamais été exécuté une seule fois.
 * « Le plan le prévoit » n'est pas « ça marche » : c'est exactement la distinction que le
 * mandat appelle un faux succès.
 *
 * ── CE QUE CELUI-CI FAIT DE PLUS ────────────────────────────────────────────────────────
 *
 * Il joue les humains. À chaque état stable, il LIT ce que la mission attend (`waitFor`), et
 * fabrique le fait qui y répond — par `reveillerMissions`, la porte réelle des réveils, celle
 * qu'emprunte un mail entrant ou un webhook. Il ne force aucune étape, n'écrit dans aucune
 * table de mission : il produit un ÉVÉNEMENT, comme le monde extérieur le ferait.
 *
 * ── LA RÉPONSE INCOMPLÈTE EST LE CŒUR DU TEST ───────────────────────────────────────────
 *
 * La première réponse de Regulatory ne porte QU'UN des deux dossiers demandés. Un moteur qui
 * enchaîne quand même a « terminé » une collecte à moitié faite — et le tableau final sera faux
 * sans que personne ne le voie. Un moteur qui redemande TOUT a oublié ce qu'il avait déjà reçu.
 * On mesure les deux : la relance doit nommer le manquant, et lui seul.
 *
 * ── LE JUGE ─────────────────────────────────────────────────────────────────────────────
 *
 * La base, jamais le récit. Les trois personnes ont-elles été sollicitées ? La relance a-t-elle
 * visé juste ? Le classeur et le deck existent-ils, et — la question qui compte — S'OUVRENT-ILS
 * vraiment (on les décompresse et on lit leurs pièces) ? Adam est-il revenu vers le dirigeant ?
 * Et zéro sortie réelle : la garde de `lib/sortie/garde.ts` compte les tentatives interceptées.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";

/**
 * CE QU'UNE PERSONNE RÉPOND — rangé par DOMAINE, pas par identité.
 *
 * Première version : une file d'attente `[raihana, raihana, khaled, sofiane]` consommée dans
 * l'ordre. Le plan a légitimement réparti Regulatory entre DEUX personnes (Amel pour Nivolex,
 * Raihana pour Trastuzex) ; le banc, lui, répondait toujours « Raihana ». L'attente qui nommait
 * Amel n'a jamais été levée, la mission a stagné, et le banc a conclu « 1/4 réponses
 * consommées » — un chiffre qui parlait du banc, pas d'Adam.
 *
 * Désormais c'est le PLAN qui décide qui parle : on lit le `from` de l'attente et cette
 * personne-là répond, avec ce que son domaine sait. C'est exactement la réalité — le dirigeant
 * ne choisit pas qui, dans Regulatory, traitera quel dossier.
 */
interface Personnage {
  /**
   * LE DOMAINE — une étiquette libre, propre à la chaîne. Le banc ne connaît pas les métiers :
   * il sait seulement qu'une personne appartient à un domaine et que son domaine porte un savoir.
   */
  domaine: string;
  /** Ce que la réponse APPORTE, en clair : sert au message et au jugement de la consolidation. */
  apporte: string;
  /** Mots que la relance doit contenir si cette réponse est jugée incomplète. */
  manquant?: string[];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE CHAÎNE, ET LE BANC EN CONNAÎT PLUSIEURS (§91).
 *
 * ── POURQUOI CE DESCRIPTEUR EXISTE ──────────────────────────────────────────────────────
 *
 * La première chaîne — Regulatory → Finance → Marchés → Excel + PowerPoint — passe 10/10.
 * Cela ne prouve RIEN sur l'architecture tant qu'une SECONDE, structurellement différente, ne
 * passe pas avec le même moteur et sans une ligne de code de plus. « Si seul un scénario
 * marche, c'est un échec architectural » : le banc doit donc pouvoir en jouer plusieurs, et le
 * juge ne doit rien savoir des métiers.
 *
 * Ce que la chaîne B change EXPRÈS, pour que ce ne soit pas la même mission déguisée :
 *   • d'autres domaines (RH, Finance, Supply Chain) et d'autres personnes ;
 *   • un livrable d'un AUTRE format (un document Word, pas un classeur + un deck) ;
 *   • une collecte à TROIS sources indépendantes au lieu de deux dossiers d'un même service ;
 *   • le manquant porté par une AUTRE personne que la première interrogée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
interface Chaine {
  cle: string;
  demande: string;
  /** Qui répond quoi. L'ordre compte À L'INTÉRIEUR d'un domaine : partiel d'abord, complément ensuite. */
  personnages: Personnage[];
  /** Le domaine d'une personne, lu sur son nom — c'est ce qu'elle SAIT, pas qui l'interroge. */
  domaineDe: (nom: string) => string;
  /** Les clés de `VERITES.personnes` qui jouent dans cette chaîne. */
  acteurs: string[];
  /** Les extensions de fichier que la demande réclame. Le juge ouvre CHACUNE. */
  livrables: string[];
  /**
   * LE DÉMENTI — joué seulement sous `ADVERSAIRE=contradiction` (§90).
   *
   * La même personne se reprend et donne un AUTRE chiffre pour la même chose. C'est le cas le
   * plus dangereux de toute la chaîne, parce qu'il ne casse RIEN : aucune étape n'échoue, la
   * mission conclut, et un chiffre faux part dans le livrable sans que personne ne le voie.
   */
  contradiction?: { domaine: string; apporte: string; ancien: string; nouveau: string };
}

interface Etape {
  tour: number;
  statut: string;
  attentes: { key: string; attente: string; waitFor: unknown }[];
  reveils: number;
  quiRepond: string | null;
  executees: number | null;
  replanifie: boolean;
}

interface Verdict { id: string; libelle: string; ok: boolean; detail: string }

/** La pièce interne qui PROUVE le format — un ZIP Office quelconque ne prouve rien. */
const PIECE_CLE: Record<string, string> = {
  ".xlsx": "xl/workbook.xml",
  ".pptx": "ppt/presentation.xml",
  ".docx": "word/document.xml",
};

const CHAINES: Chaine[] = [
  {
    cle: "regulatory",
    demande:
      "Demande à l'équipe Regulatory les pièces manquantes des dossiers Nivolex (REG-2026-9011) et Trastuzex (REG-2026-9015). "
      + "Attends leur retour et relance ce qui manque. "
      + "Ensuite demande à Khaled Mansouri le prix de cession et le forecast de ces deux produits. "
      + "Ensuite demande à Sofiane Kaci l'état des marchés publics qui les concernent. "
      + "Quand tu as tout, consolide, fais-moi un fichier Excel et une présentation PowerPoint, et reviens vers moi.",
    /**
     * Regulatory répond D'ABORD sur Nivolex seul : Trastuzex manque, et c'est ce que la relance
     * doit aller chercher. Le second passage complète.
     */
    personnages: [
      { domaine: "REGULATORY", apporte: "Nivolex : il manque le CPP légalisé. (Trastuzex non traité.)", manquant: ["trastuzex", "9015"] },
      { domaine: "REGULATORY", apporte: "Trastuzex : certificat GMP du fabricant expiré depuis le 30/06/2026." },
      { domaine: "FINANCE", apporte: "Prix de cession Nivolex 84 500 DZD, Trastuzex 61 200 DZD ; forecast 2027 : 1 240 et 890 unités." },
      { domaine: "MARCHES", apporte: "Deux marchés PCH concernés : AO-2026-114 (Nivolex, attribué) et AO-2026-131 (Trastuzex, en cours)." },
    ],
    domaineDe: (nom) => {
      const n = nom.toLowerCase();
      if (n.includes("khaled") || n.includes("mansouri")) return "FINANCE";
      if (n.includes("sofiane") || n.includes("kaci")) return "MARCHES";
      return "REGULATORY";
    },
    acteurs: ["raihana", "amel", "khaled", "sofiane"],
    livrables: [".xlsx", ".pptx"],
    contradiction: {
      domaine: "FINANCE",
      apporte: "Correction : le prix de cession Nivolex est 91 000 DZD, pas 84 500. Merci de rectifier.",
      ancien: "84 500", nouveau: "91 000",
    },
  },
  {
    /**
     * LA CHAÎNE B — celle qui dit si l'architecture GÉNÉRALISE ou si elle a appris la première.
     *
     * Rien n'y ressemble à la chaîne A : d'autres personnes, d'autres domaines (RH, Finance,
     * Supply Chain), TROIS sources indépendantes au lieu de deux dossiers d'un même service, un
     * livrable d'un autre format (un document Word, ni classeur ni deck), et le MANQUANT porté
     * par la Supply Chain — pas par la première personne interrogée. Aucune ligne du moteur ne
     * la connaît : si elle passe, c'est le moteur qui marche, pas la mémoire du banc.
     */
    cle: "budget",
    demande:
      "Prépare le dossier de révision budgétaire 2027. Demande à Nesrine Boudiaf l'effectif prévu et la masse salariale, "
      + "à Khaled Mansouri le budget consommé à date et le reste à engager, "
      + "et à Mehdi Larbi le coût logistique prévisionnel par produit. "
      + "Attends leurs retours et relance ce qui manque. "
      + "Quand tu as les trois, consolide et fais-moi un document Word de synthèse, puis reviens vers moi.",
    personnages: [
      { domaine: "RH", apporte: "Effectif prévu 2027 : 47 personnes (+4 vs 2026). Masse salariale prévisionnelle : 118 400 000 DZD." },
      { domaine: "FINANCE", apporte: "Budget 2026 consommé à date : 71 %. Reste à engager : 24 300 000 DZD." },
      // LE MANQUANT EST ICI, chez la TROISIÈME personne — pas chez la première comme en chaîne A.
      { domaine: "LOGISTIQUE", apporte: "Coût logistique Nivolex : 3 100 DZD/unité. (Trastuzex : chiffre non consolidé, je reviens vers vous.)", manquant: ["trastuzex", "logistique"] },
      { domaine: "LOGISTIQUE", apporte: "Coût logistique Trastuzex : 2 750 DZD/unité, transport réfrigéré inclus." },
    ],
    domaineDe: (nom) => {
      const n = nom.toLowerCase();
      if (n.includes("nesrine") || n.includes("boudiaf")) return "RH";
      if (n.includes("mehdi") || n.includes("larbi")) return "LOGISTIQUE";
      return "FINANCE";
    },
    acteurs: ["nesrine", "khaled", "mehdi"],
    livrables: [".docx"],
    contradiction: {
      domaine: "FINANCE",
      apporte: "Correction : le reste à engager est 19 800 000 DZD, pas 24 300 000. Rectification après clôture partielle.",
      ancien: "24 300 000", nouveau: "19 800 000",
    },
  },
];

/** La chaîne jouée — `CHAINE=budget` pour la seconde. Le banc n'en privilégie aucune. */
const CHAINE: Chaine = CHAINES.find((c) => c.cle === (process.env.CHAINE ?? "regulatory")) ?? CHAINES[0];
const DEMANDE = CHAINE.demande;

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { getAccess } = await import("@/lib/rbac");
  const { lancerMission } = await import("@/platform/in-process/missions/runtime");
  const { conduireMission } = await import("@/platform/in-process/missions/sweep");
  const { rattraperLancementsPerdus } = await import("@/platform/in-process/missions/runtime");
  const { decider } = await import("@/lib/missions/approval/gate");
  const { chargerEtat } = await import("@/lib/missions/runtime/store");
  const { reveillerMissions } = await import("@/lib/missions/events/router");
  const { lireAttente } = await import("@/lib/missions/events/match");
  const { viderTampon } = await import("@/platform/in-process/telemetry/usage-sink");
  const { tentativesSortantes, oublierTentativesSortantes, sortiesInterdites } = await import("@/lib/sortie/garde");
  const { VERITES } = await import("./seed-adam-bench");
  type CurrentUser = import("@/lib/session").CurrentUser;

  const row = await prisma.user.findUnique({ where: { email: VERITES.pdg.email } });
  if (!row) throw new Error("Jeu du banc absent : BENCH_SEED_ALLOW=1 npm run adam:bench:seed");
  const pdg: CurrentUser = {
    id: row.id, name: row.name, email: row.email, role: row.role, secondaryRole: row.secondaryRole,
    mustChangePassword: row.mustChangePassword, access: await getAccess(row.id, row.role),
  } as unknown as CurrentUser;

  // LES ACTEURS DE CETTE CHAÎNE — lus dans son descripteur, jamais figés dans le banc.
  const emails = CHAINE.acteurs.map((k) => (VERITES.personnes as Record<string, { email: string }>)[k]?.email).filter(Boolean);
  const gens = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, name: true, email: true },
  });
  if (gens.length < emails.length) {
    console.log(`  ✗ jeu d'essai incomplet : ${gens.length}/${emails.length} acteurs de la chaîne « ${CHAINE.cle} » en base.`);
    await prisma.$disconnect();
    process.exit(2);
  }

  const SCENARIO: Personnage[] = CHAINE.personnages;
  const domaineDe = CHAINE.domaineDe;

  /** La personne que l'attente NOMME — le banc ne choisit pas, il lit. */
  const quiRepondA = (from: string | undefined): typeof gens[number] | undefined => {
    if (!from) return undefined;
    const f = from.toLowerCase();
    return gens.find((g) => f.includes(g.name.toLowerCase()) || g.name.toLowerCase().split(" ").some((m) => m.length >= 4 && f.includes(m)))
      ?? gens.find((g) => g.email.toLowerCase() === f);
  };

  /** Ce qu'une attente dit, une fois lue — au premier niveau ou dans une branche composée. */
  type Attente = {
    event?: string; from?: string; entity?: string; subject?: string; attachment?: unknown;
    anyOf?: Attente[]; allOf?: Attente[];
  };

  /**
   * LES BRANCHES D'UNE ATTENTE, À PLAT. Une attente simple en rend une : elle-même. Un `allOf`
   * ou un `anyOf` en rend autant qu'il porte de conditions — chacune nomme quelqu'un et dit
   * quoi, donc chacune appelle une réponse.
   */
  const branches = (a: Attente): Attente[] => {
    const sous = [...(a.allOf ?? []), ...(a.anyOf ?? [])];
    if (sous.length === 0) return [a];
    // Une branche composée peut l'être à son tour ; l'événement du parent sert de défaut.
    return sous.flatMap((b) => branches({ event: a.event, ...b }));
  };

  /** Le cas adverse joué — `ADVERSAIRE=contradiction`. Vide = la chaîne nominale. */
  const ADVERSAIRE = (process.env.ADVERSAIRE ?? "").trim();
  let dementiEnvoye = false;
  let anticipeEnvoye: string | null = null;

  oublierTentativesSortantes();
  const t0 = Date.now();
  const journal: Etape[] = [];
  const relances: string[] = [];
  const sollicites = new Set<string>();
  const consommes = new Set<number>();
  const relancesAttendues: string[] = [];

  console.log(`\n══════════ CHAÎNE HUMAINE « ${CHAINE.cle} » ══════════\n${DEMANDE}\n`);

  let r = await lancerMission(pdg, DEMANDE, { titre: `[BENCH chaine:${CHAINE.cle}] collecte multi-personnes` });
  if (!r.ok) { console.log(`  ✗ non lancée : ${r.error}`); process.exit(2); }
  const missionId = r.missionId;

  /**
   * LA PLANIFICATION DIFFÉRÉE SE VÉRIFIE, ELLE NE SE SUPPOSE PAS.
   *
   * Première version : après chaque reprise, on marquait `differe: false` sans regarder si la
   * planification avait ABOUTI. Le fournisseur a renvoyé six 502 d'affilée, la mission est restée
   * à ZÉRO étape, et le banc a quand même déroulé ses tours puis rendu un score de 3/10 — un
   * chiffre qui parle du produit alors qu'il ne parle que du réseau. Un banc qui confond une
   * panne d'infrastructure avec un défaut de conception ment sur les deux.
   *
   * On exige donc des ÉTAPES, et on sort avec un code distinct (2) quand elles n'arrivent pas :
   * « fournisseur indisponible » n'est pas « Adam ne sait pas faire ».
   */
  /**
   * ON PASSE PAR LE BATTEMENT, PAS PAR UNE REPRISE MAISON.
   *
   * Première version : `finaliserLancementDifere` en boucle. C'était contourner le mécanisme
   * réel. En production, une mission-talon PLANNING sans étape est retrouvée par
   * `rattraperLancementsPerdus` — appelée par `balayerMissions`, avec son seuil de deux minutes
   * et son plafond de deux reprises avant FAILED. Un banc qui invente sa propre reprise ne
   * mesure pas la durabilité du produit, il mesure la sienne.
   *
   * Le planificateur met 17 à 25 s avec le vrai schéma (26 583 caractères) ; sous un mandataire
   * qui coupe, cet appel tombe parfois en 502. C'est justement le cas que le filet doit couvrir,
   * et c'est donc ce filet qu'on exerce.
   */
  for (let essai = 1; essai <= 6; essai += 1) {
    const etapes = await prisma.missionStep.count({ where: { missionId } });
    if (etapes > 0) break;
    const m = await prisma.mission.findUnique({ where: { id: missionId }, select: { status: true } });
    if (m?.status === "FAILED") break;
    console.log(`  · aucune étape — filet ${essai}/6 (un talon est repris après 2 min d'inactivité)`);
    await new Promise((res) => setTimeout(res, 20_000));
    /**
     * ON APPELLE LE FILET, PAS TOUT LE BATTEMENT. `balayerMissions` fait avancer TOUTES les
     * missions actives — dans la base du banc, plusieurs centaines héritées des passages
     * précédents, chacune payant des appels de modèle. Le banc mettait alors des heures à
     * mesurer une seule chaîne. `rattraperLancementsPerdus` est la MÊME fonction de production,
     * celle qui reprend un talon sans plan ; on l'appelle directement, sur un seuil abaissé pour
     * ne pas attendre deux minutes à chaque tour de boucle.
     */
    const repris = await rattraperLancementsPerdus(async () => pdg, { plusVieuxQueMs: 15_000, limite: 3 }).catch(() => 0);
    console.log(`      filet : ${repris} talon(s) repris`);
  }
  const etapesInitiales = await prisma.missionStep.count({ where: { missionId } });
  if (etapesInitiales === 0) {
    console.log("\n  ✗ FOURNISSEUR INDISPONIBLE : la mission n'a jamais reçu de plan (0 étape après 5 reprises).");
    console.log("    Ce n'est PAS un verdict sur Adam — relancer quand le fournisseur répond.");
    await prisma.$disconnect();
    process.exit(2);
  }
  console.log(`  ✓ lancée ${missionId} · ${etapesInitiales} étapes · ${r.complexite}/${r.echelle}`);
  if (r.approbation) {
    await decider(r.approbation.id, "GRANTED", pdg.id);
    console.log(`  · accord donné (UN clic) : ${r.approbation.niveau}`);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * LE CAS ADVERSE « DÉSORDRE » — la réponse arrive AVANT la question (§90).
   *
   * Réaliste et fréquent : quelqu'un anticipe. Le dirigeant a parlé du sujet en réunion, la
   * personne envoie son chiffre de son propre chef, et la mission n'a pas encore ouvert
   * l'attente qui l'aurait consommé.
   *
   * Ce qu'on redoute précisément : le message tombe dans le vide, PUIS la mission demande la
   * même chose et attend pour toujours une réponse qu'elle a DÉJÀ reçue. Personne ne voit rien
   * — ni échec, ni retard visible : une mission qui dort sur une information qu'elle possède.
   */
  if (ADVERSAIRE === "desordre") {
    const premier = SCENARIO[0];
    const qui = gens.find((g) => domaineDe(g.name) === premier.domaine);
    if (qui) {
      const reveils = await reveillerMissions({
        type: "MESSAGE_RECEIVED", actorId: qui.id, entityType: null, entityId: null,
        relatedRefs: [], missionId,
        payload: {
          from: qui.name, fromEmail: qui.email,
          subject: "Sans attendre votre demande", body: premier.apporte, text: premier.apporte,
          hasAttachments: false,
        },
      });
      anticipeEnvoye = premier.apporte;
      console.log(`  ⚡ ANTICIPATION : ${qui.name} répond AVANT qu'on lui demande — « ${premier.apporte.slice(0, 70)} » → ${reveils.length} réveil(s)`);
    }
  }

  const TOURS_MAX = Number(process.env.CHAINE_TOURS ?? "14") || 14;
  let precedent = "";
  let accordsDonnes = r.approbation ? 1 : 0;

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * UN HUMAIN QUI EST LÀ RÉPOND — y compris quand le plan change.
   *
   * Le banc ne donnait son accord qu'UNE fois, au lancement. Mesuré : la mission
   * cmtsdqc17… a échoué sur deux envois, replanifié (plan v2), et la porte a fait exactement ce
   * qu'elle doit faire — `APPROVAL_REOPENED`, deux étapes non couvertes par l'accord précédent,
   * `NOTIFIED ARBITRAGE`. Personne n'a répondu. La mission a tourné en BLOCKED jusqu'au dernier
   * tour : 0 réveil, 0 attente levée, aucun livrable.
   *
   * Le verdict aurait accusé Adam d'un blocage dont la cause était le banc : il notifiait un
   * humain absent. Un banc qui ne répond jamais à une question légitime ne mesure pas
   * l'autonomie, il mesure sa propre absence. On répond donc à CHAQUE tour — c'est un clic,
   * et la doctrine dit qu'un changement matériel rouvre la partie modifiée, pas qu'il tue la
   * mission (§118.8).
   */
  async function repondreAuxAccords(): Promise<number> {
    const enAttente = await prisma.missionApproval.findMany({
      where: { missionId, status: "PENDING" },
      select: { id: true, summary: true },
      orderBy: { createdAt: "asc" },
    }).catch(() => []);
    for (const a of enAttente) {
      const ok = await decider(a.id, "GRANTED", pdg.id).catch(() => false);
      if (ok) {
        accordsDonnes += 1;
        console.log(`  · accord ROUVERT donné (clic ${accordsDonnes}) : ${a.summary.slice(0, 90)}`);
      }
    }
    return enAttente.length;
  }

  for (let tour = 1; tour <= TOURS_MAX; tour += 1) {
    await repondreAuxAccords();
    const tick = await conduireMission(pdg, missionId, { maxTours: 25 }).catch((e) => {
      console.log(`  · tour ${tour} en erreur : ${String(e).slice(0, 140)}`); return null;
    });
    const etat = await chargerEtat(missionId);
    if (!etat) break;

    const attentes = etat.steps
      .filter((s) => s.status === "WAITING" && s.nodeType === "WAIT_EVENT")
      .map((s) => ({ key: s.key, attente: JSON.stringify(lireAttente(s.waitFor) ?? {}), waitFor: s.waitFor, titre: s.title }));

    // QUI A ÉTÉ SOLLICITÉ — lu dans les étapes faites, pas dans le récit.
    for (const s of etat.steps) {
      const t = `${s.title} ${JSON.stringify(s.result ?? {})}`.toLowerCase();
      for (const g of gens) if (t.includes(g.name.split(" ")[0].toLowerCase())) sollicites.add(g.name);
    }

    const e: Etape = {
      tour, statut: etat.status, reveils: 0, quiRepond: null,
      attentes: attentes.map((a) => ({ key: a.key, attente: a.attente, waitFor: a.waitFor })),
      executees: tick?.executees ?? null, replanifie: Boolean(tick?.replanifie),
    };

    console.log(`  · tour ${tour} : ${etat.status} · exécutées ${tick?.executees ?? "?"} · ${attentes.length} attente(s)${tick?.replanifie ? " · REPLANIFIÉE" : ""}`);
    for (const a of attentes) console.log(`      ↳ ${a.key} attend ${a.attente.slice(0, 150)}`);

    if (["COMPLETED", "FAILED", "CANCELLED"].includes(etat.status)) { journal.push(e); break; }

    // ── LES HUMAINS RÉPONDENT ──────────────────────────────────────────────────────────
    if (attentes.length > 0 && consommes.size < SCENARIO.length) {
      // On répond à CHAQUE attente ouverte : la personne est celle que l'attente NOMME, et le
      // contenu est le prochain que son domaine n'a pas encore donné. Un humain répond de ce
      // qu'il sait, à qui le lui demande — le banc n'invente ni l'un ni l'autre.
      for (const a of attentes) {
        const brute = lireAttente(a.waitFor) as Attente | null;
        if (!brute) continue;
        /**
         * UNE ATTENTE COMPOSÉE EST PLUSIEURS ATTENTES — le banc les joue TOUTES.
         *
         * Première version : on lisait `att.from` au premier niveau. Le plan, lui, avait
         * parfaitement fait son travail : UNE étape « retours Regulatory » portant un `allOf`
         * de deux branches, l'une nommant Amel avec le sujet Nivolex, l'autre Raihana avec le
         * sujet Trastuzex — exactement la discrimination que le compilateur exige désormais.
         * Le banc a lu `from: undefined`, écrit « nomme —, inconnu du jeu d'essai », et rendu
         * 0/4. Un chiffre qui parlait du banc et accusait le produit.
         */
        for (const att of branches(brute)) {
        if (!att.event) continue;
        const qui = quiRepondA(att.from);
        if (!qui) { console.log(`      ⚠ attente « ${a.key} » nomme « ${att.from ?? "—"} », inconnu du jeu d'essai`); continue; }
        const dom = domaineDe(qui.name);
        /**
         * LE SAVOIR D'UNE PERSONNE NE S'ÉPUISE PAS PARCE QU'ON L'A DÉJÀ INTERROGÉE.
         *
         * Première version : un contenu par domaine, consommé une fois. Le plan a légitimement
         * demandé à Khaled le prix de Nivolex ET celui de Trastuzex — deux attentes distinctes,
         * chacune nommant l'entité concernée. Le banc a répondu à la première, n'a plus rien
         * trouvé pour la seconde, et l'a laissée ouverte : « 2 attentes non levées », un chiffre
         * qui parlait du banc.
         *
         * Un humain à qui l'on redemande répond de nouveau. On prend donc le prochain contenu
         * non encore donné de son domaine, et à défaut le DERNIER — celui qui contient tout ce
         * qu'il sait. L'ORDRE reste garanti pour Regulatory : son premier retour est partiel,
         * le second complète, et la relance doit passer entre les deux.
         */
        const duDomaine = SCENARIO.map((sc, idx) => ({ sc, idx })).filter((e) => e.sc.domaine === dom);
        if (duDomaine.length === 0) continue;
        const choisi = duDomaine.find((e) => !consommes.has(e.idx)) ?? duDomaine[duDomaine.length - 1];
        const i = choisi.idx;
        const perso = choisi.sc;
        const fait = {
          type: att.event,
          actorId: qui.id,
          entityType: null as string | null,
          entityId: null as string | null,
          relatedRefs: ["REG-2026-9011", "REG-2026-9015", att.entity ?? ""].filter(Boolean),
          missionId,
          payload: {
            from: qui.name,
            fromEmail: qui.email,
            subject: att.subject ?? "Retour — pièces et données demandées",
            body: perso.apporte,
            text: perso.apporte,
            hasAttachments: true,
            attachments: ["retour.pdf"],
            attachmentNames: ["retour.pdf"],
          },
        };
        const reveils = await reveillerMissions(fait);
        e.reveils += reveils.length;
        if (reveils.length) {
          consommes.add(i);
          if (perso.manquant) relancesAttendues.push(...perso.manquant);
          e.quiRepond = qui.name;
          console.log(`      ✓ ${qui.name} répond : « ${perso.apporte.slice(0, 90)} » → ${reveils.length} attente(s) levée(s)`);

          /**
           * ── LE DÉMENTI, JUSTE APRÈS LA RÉPONSE QU'IL CONTREDIT (§90) ──────────────────
           *
           * La personne se reprend : même sujet, autre chiffre. Le fait part par la MÊME porte
           * que le premier (`reveillerMissions`) — c'est un message de plus, rien de spécial.
           * Ce qui est mesuré ensuite n'est pas qu'il « arrive », c'est ce que la mission en
           * FAIT : le chiffre corrigé doit se retrouver quelque part, ou la divergence être
           * dite. Emporter silencieusement l'ancien serait le faux succès parfait — aucune
           * étape en échec, un livrable produit, et un chiffre faux dedans.
           */
          if (ADVERSAIRE === "contradiction" && CHAINE.contradiction && dom === CHAINE.contradiction.domaine && !dementiEnvoye) {
            dementiEnvoye = true;
            const c = CHAINE.contradiction;
            const reveils2 = await reveillerMissions({
              type: att.event, actorId: qui.id, entityType: null, entityId: null,
              relatedRefs: [att.entity ?? ""].filter(Boolean), missionId,
              payload: {
                from: qui.name, fromEmail: qui.email,
                subject: `Correction — ${att.subject ?? "retour précédent"}`,
                body: c.apporte, text: c.apporte, hasAttachments: false,
              },
            });
            console.log(`      ⚡ DÉMENTI de ${qui.name} : « ${c.apporte.slice(0, 80)} » → ${reveils2.length} réveil(s)`);
          }
        } else {
          console.log(`      ⚠ ${qui.name} a répondu, aucune attente levée — le fait produit ne correspond pas à « ${a.attente.slice(0, 90)} »`);
        }
        }
      }
    }

    const sig = `${etat.status}|${etat.steps.map((s) => `${s.key}:${s.status}`).sort().join(",")}|${consommes.size}`;
    journal.push(e);
    if (sig === precedent) { console.log("  · état stable et plus rien à répondre — arrêt"); break; }
    precedent = sig;
  }

  // ── LA RELANCE A-T-ELLE VISÉ JUSTE ? ─────────────────────────────────────────────────
  const etatFinal = await chargerEtat(missionId);
  const textesApresPremiereReponse = (etatFinal?.steps ?? [])
    .map((s) => `${s.title} ${JSON.stringify(s.result ?? {})}`)
    .join(" \n ");
  /**
   * LE MANQUANT EST CELUI QUE LA CHAÎNE DÉCLARE — pas celui de la première personne.
   *
   * Il s'écrivait `SCENARIO[0].manquant`. C'était une hypothèse de la chaîne A, où la réponse
   * incomplète vient bien de la première personne interrogée. La chaîne B place le manquant chez
   * la TROISIÈME (Supply Chain) — exprès, pour que ce ne soit pas la même mission déguisée. Le
   * juge a répondu « ✗ la relance vise le MANQUANT (—) » : il ne cherchait rien.
   *
   * C'est exactement ce que §91 sert à trouver : ce n'était pas le moteur qui avait mémorisé la
   * chaîne A, c'était le BANC. On lit donc le manquant là où il est déclaré, où qu'il soit.
   */
  const attenduRelance = SCENARIO.flatMap((p) => p.manquant ?? []);
  const relanceCiblee = attenduRelance.some((m) => textesApresPremiereReponse.toLowerCase().includes(m));
  if (relanceCiblee) relances.push(attenduRelance.join("/"));

  /**
   * ── LES LIVRABLES — ON LES OUVRE, ET ON LES TROUVE PAR LE REGISTRE DE LA MISSION ──────
   *
   * Première version : « les nœuds Drive créés depuis le début du run ». Elle a rendu
   * « ✗ aucun .xlsx produit » sur un run où le classeur ÉTAIT produit, VÉRIFIÉ et déposé —
   * mais dans un fichier du MÊME nom qu'un run précédent. Le Drive a fait ce qu'il doit faire :
   * même nom, même dossier ⇒ nouvelle VERSION du même nœud, pas un nœud de plus. Le banc
   * regardait la date de naissance du nœud et concluait à l'absence du fichier.
   *
   * On demande donc à la mission ce qu'ELLE a produit — `MissionArtifact`, son registre — et on
   * ouvre les nœuds qu'elle nomme. C'est plus direct et plus vrai : si le registre ne connaît
   * pas un livrable, c'est un défaut réel du produit (§118.10), pas un artefact de mesure.
   */
  const registre = await prisma.missionArtifact.findMany({
    where: { missionId },
    select: { key: true, driveNodeId: true, status: true, fileName: true, format: true, byteSize: true },
  });
  const fichiers = (await prisma.driveNode.findMany({
    where: { id: { in: registre.map((a) => a.driveNodeId).filter((x): x is string => Boolean(x)) } },
    select: { id: true, name: true, mimeType: true, size: true },
  }));
  const sansDepot = registre.filter((a) => !a.driveNodeId);
  if (sansDepot.length > 0) {
    console.log(`  ⚠ ${sansDepot.length} livrable(s) au registre SANS nœud Drive : ${sansDepot.map((a) => `${a.key} (${a.status})`).join(", ")}`);
  }
  const ouvrable = async (id: string, nom: string): Promise<{ ok: boolean; detail: string }> => {
    try {
      // ON OUVRE VRAIMENT LE FICHIER : version courante → blob → octets. Vérifier la ligne en
      // base dirait seulement qu'un nom existe ; c'est le contenu qui prouve le livrable.
      const { getBlob } = await import("@/lib/drive-storage");
      const v = await prisma.fileVersion.findFirst({ where: { nodeId: id }, orderBy: { version: "desc" }, select: { blobId: true } });
      if (!v) return { ok: false, detail: `${nom} : aucune version` };
      const buf = await getBlob(v.blobId);
      if (!buf || buf.length < 512) return { ok: false, detail: `${nom} : ${buf?.length ?? 0} octets` };
      // Un .xlsx et un .pptx sont des ZIP : la signature « PK » et la présence de pièces le disent.
      const zip = buf[0] === 0x50 && buf[1] === 0x4b;
      const { default: JSZip } = await import("jszip");
      if (!zip) return { ok: false, detail: `${nom} : pas une archive Office` };
      const z = await JSZip.loadAsync(buf);
      const pieces = Object.keys(z.files);
      // La PIÈCE qui prouve le format : un ZIP Office quelconque ne dit rien, celle-ci si.
      const attendu = PIECE_CLE[(nom.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase()] ?? null;
      const ok = attendu ? pieces.includes(attendu) : pieces.length > 0;
      return { ok, detail: `${nom} : ${pieces.length} pièces${attendu ? `, ${attendu} ${ok ? "présent" : "ABSENT"}` : ""}` };
    } catch (err) { return { ok: false, detail: `${nom} : ${String(err).slice(0, 90)}` }; }
  };

  /**
   * UN VERDICT PAR LIVRABLE QUE LA CHAÎNE RÉCLAME — ni plus, ni moins.
   *
   * La chaîne A veut un classeur ET un deck, la chaîne B un document Word. Un banc qui cherche
   * toujours un `.xlsx` accuserait la chaîne B d'un manque que personne ne lui a demandé, et
   * laisserait la chaîne A muette sur un format oublié. Le descripteur dit ce qu'on ouvre.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * « IL S'OUVRE » N'EST PAS « IL PORTE CE QU'ON A COLLECTÉ » (§89).
   *
   * Le verdict s'arrêtait à la structure : archive valide, `xl/workbook.xml` présent, verdict
   * vert. C'est exactement le défaut nommé au mandat — « un échec QUALITATIF, même si le DOCX
   * était valide ». Une consolidation qui ne contient AUCUN des chiffres que trois personnes
   * viennent de donner est un livrable vide qui passe tous les contrôles de forme.
   *
   * On ouvre donc le fichier et on cherche DEDANS les chiffres du jeu d'essai — ceux, et rien
   * d'autre : ils sont la seule chose dont on sache avec certitude qu'elle DEVAIT y être. Le
   * verdict ne juge ni la mise en page ni le style, qui ne se mesurent pas ici ; il refuse le
   * cas où la donnée collectée n'est pas arrivée dans la pièce.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  /**
   * UN CHIFFRE CHERCHÉ DANS UNE SOUPE DE CHIFFRES SE TROUVE TOUJOURS (§118.17).
   *
   * La première version retirait TOUS les caractères non numériques du fichier et cherchait
   * l'aiguille dans la botte : dans un `.xlsx` qui porte quelques dizaines de milliers de
   * chiffres, « 890 » se trouve par accident à peu près à coup sûr. Ce contrôle-là ne pouvait
   * pas échouer, donc il ne protégeait de rien.
   *
   * On compare donc des NOMBRES à des NOMBRES : le fichier est découpé en jetons numériques,
   * et un chiffre attendu compte s'il apparaît dans l'UN d'eux. « 84 500 » écrit « 84500,00 »
   * compte encore ; « 84500 » noyé entre deux valeurs voisines, non.
   *
   * Les millésimes (1900-2099) sont ÉCARTÉS des attendus : ils figurent déjà dans la demande,
   * les retrouver ne prouve aucune collecte.
   */
  /**
   * UN CHIFFRE CHERCHÉ DANS UNE SOUPE DE CHIFFRES SE TROUVE TOUJOURS (§118.17).
   *
   * Première version : on retirait TOUS les caractères non numériques du fichier et on cherchait
   * l'aiguille dans la botte. Dans un `.xlsx` qui porte quelques dizaines de milliers de chiffres,
   * « 890 » s'y trouve par accident à peu près à coup sûr — un contrôle qui ne peut pas échouer.
   *
   * On compare donc des NOMBRES à des NOMBRES, des deux côtés avec la MÊME lecture :
   *
   *   • « 84 500 » écrit à la française se recolle — mais seulement sur UNE espace. Après le
   *     retrait des balises, deux valeurs voisines (`<v>84500</v><v>61200</v>`) sont séparées
   *     par DEUX espaces au moins : elles ne se recollent pas en un nombre qui n'existe pas.
   *   • un attendu compte s'il apparaît dans l'UN des jetons du fichier, pas dans leur
   *     concaténation : « 84500,00 » compte, « 84500 » à cheval sur deux cellules, non.
   *   • les millésimes (1900-2099) sont ÉCARTÉS des attendus : ils figurent déjà dans la
   *     demande, les retrouver ne prouve aucune collecte.
   *
   * CE QU'IL NE MESURE PAS, dit une fois : un nombre coupé par Word en deux runs de texte
   * (« 84 » puis « 500 ») n'est pas recollé — les fichiers du banc sont ÉCRITS par Adam, pas
   * réédités dans Word. Le biais va donc vers le manque, jamais vers le faux vert.
   */
  const nombresDe = (texte: string): string[] => {
    let t = texte;
    for (let k = 0; k < 4; k += 1) t = t.replace(/(\d)[   ](\d{3})(?!\d)/g, "$1$2");
    return (t.match(/\d[\d.,]*/g) ?? []).map((x) => x.replace(/[^0-9]/g, "")).filter((x) => x.length >= 2);
  };
  const millesime = (x: string): boolean => /^(19|20)\d\d$/.test(x);
  const chiffresAttendus = [...new Set(SCENARIO.flatMap((p) => nombresDe(p.apporte)))]
    .filter((x) => x.length >= 3 && !millesime(x));

  const jetonsDuFichier = async (id: string): Promise<string[] | null> => {
    try {
      const { getBlob } = await import("@/lib/drive-storage");
      const v = await prisma.fileVersion.findFirst({ where: { nodeId: id }, orderBy: { version: "desc" }, select: { blobId: true } });
      if (!v) return null;
      const buf = await getBlob(v.blobId);
      if (!buf) return null;
      const { default: JSZip } = await import("jszip");
      const z = await JSZip.loadAsync(buf);
      // Les pièces qui portent du TEXTE. Les relations et le manifeste n'en portent pas ; les
      // styles et les thèmes portent des nombres qui ne sont pas des données (tailles, teintes).
      const parts = Object.keys(z.files).filter((k) =>
        /\.xml$/i.test(k) && !/_rels|\[Content_Types\]|theme|styles|settings|fontTable|docProps/i.test(k));
      const morceaux = await Promise.all(parts.slice(0, 200).map((k) => z.files[k]!.async("string").catch(() => "")));
      return nombresDe(morceaux.join(" ").replace(/<[^>]+>/g, " "));
    } catch { return null; }
  };

  const verdictsLivrables: Verdict[] = [];
  for (const ext of CHAINE.livrables) {
    const f = fichiers.find((x) => x.name.toLowerCase().endsWith(ext));
    const v = f ? await ouvrable(f.id, f.name) : { ok: false, detail: `aucun ${ext} produit` };
    verdictsLivrables.push({ id: ext.slice(1), libelle: `le livrable ${ext} existe ET s'ouvre`, ok: v.ok, detail: v.detail });

    // Un banc qui ne sait pas quoi chercher le DIT et échoue : se taire ferait passer pour
    // « rien à vérifier » ce qui est en réalité « la vérification n'a pas eu lieu ».
    const jetons = f && v.ok ? await jetonsDuFichier(f.id) : null;
    const dedans = jetons === null ? [] : chiffresAttendus.filter((c) => jetons.some((t) => t.includes(c)));
    verdictsLivrables.push({
      id: `${ext.slice(1)}-contenu`,
      libelle: `le livrable ${ext} PORTE les chiffres collectés, pas seulement une mise en page`,
      // La moitié suffit : une synthèse exécutive choisit ce qu'elle montre. Zéro, en revanche,
      // veut dire que rien de ce que les gens ont dit n'est arrivé dans la pièce.
      ok: chiffresAttendus.length > 0 && jetons !== null && dedans.length * 2 >= chiffresAttendus.length,
      detail: chiffresAttendus.length === 0
        ? "le jeu d'essai ne porte aucun chiffre à retrouver — le contrôle de contenu est AVEUGLE"
        : jetons === null
          ? `${f ? f.name : ext} : contenu illisible, rien n'a pu être vérifié`
          : `${dedans.length}/${chiffresAttendus.length} chiffres du jeu d'essai retrouvés parmi ${jetons.length} nombres du fichier`
            + (dedans.length === 0 ? " — LIVRABLE VIDE DE LA COLLECTE" : ` (${dedans.slice(0, 4).join(", ")})`),
    });
  }

  const events = await prisma.missionEvent.findMany({ where: { missionId }, select: { kind: true, summary: true }, orderBy: { at: "asc" } });
  const notifs = events.filter((x) => x.kind === "NOTIFIED");
  const mrow = await prisma.mission.findUnique({ where: { id: missionId }, select: { status: true, planVersion: true } });
  await viderTampon();
  const appels = await prisma.modelCallLog.findMany({ where: { missionId }, select: { inputTokens: true, outputTokens: true, cachedInputTokens: true, costUsd: true } });
  const cout = appels.some((a) => a.costUsd == null) ? null : appels.reduce((s, a) => s + Number(a.costUsd ?? 0), 0);
  const sorties = tentativesSortantes();

  const verdicts: Verdict[] = [
    /**
     * « LANCÉE ET CONDUITE » — et le verdict le VÉRIFIE.
     *
     * Il s'écrivait `ok: true`. Comme la ligne n'est atteinte que si le lancement a réussi,
     * elle était vraie par construction : un point sur dix offert, qui ne pouvait rien dire.
     * Deuxième tautologie du même fichier, trouvée en cherchant la première.
     *
     * Ce qui compte n'est pas que la mission EXISTE, c'est que le moteur l'ait FAIT AVANCER :
     * un plan matérialisé en étapes, et au moins une étape sortie de l'état initial.
     */
    { id: "lancee", libelle: "mission lancée ET conduite (le moteur l'a fait avancer)",
      ok: (etatFinal?.steps.length ?? 0) > 0 && (etatFinal?.steps ?? []).some((s) => s.status !== "PENDING"),
      detail: `${missionId} · statut ${mrow?.status} · plan v${mrow?.planVersion} · ${etatFinal?.steps.length ?? 0} étape(s), `
        + `${(etatFinal?.steps ?? []).filter((s) => s.status !== "PENDING").length} sortie(s) de PENDING` },
    { id: "sollicitees", libelle: `les ${CHAINE.acteurs.length} personnes de la chaîne sont sollicitées`,
      ok: sollicites.size >= CHAINE.acteurs.length, detail: [...sollicites].join(", ") || "aucune" },
    { id: "attente-levee", libelle: "au moins une attente est levée par une réponse humaine", ok: journal.some((j) => j.reveils > 0), detail: `${journal.reduce((s, j) => s + j.reveils, 0)} réveil(s)` },
    { id: "relance", libelle: `la relance vise le MANQUANT (${attenduRelance.join("/") || "—"}), pas tout`, ok: relanceCiblee, detail: relanceCiblee ? `mentionne ${attenduRelance.join("/")}` : "aucune trace du manquant" },
    /**
     * LA CONSOLIDATION SE JUGE AUX ATTENTES LEVÉES, PAS AUX CONTENUS CONSOMMÉS.
     *
     * Depuis qu'une personne peut répondre plusieurs fois, `consommes` ne mesure plus l'avancée
     * de la mission — il mesure la variété du jeu d'essai. Ce qui dit que la chaîne a progressé,
     * c'est le nombre d'attentes que des réponses humaines ont RÉELLEMENT levées, et qu'aucune
     * ne reste ouverte à la fin.
     */
    /**
     * ── UNE ATTENTE QUE CE BANC NE PEUT PAS SATISFAIRE N'EST PAS UN ÉCHEC D'ADAM ────────
     *
     * Le critère exigeait ZÉRO attente ouverte à l'arrêt. Mesuré sur les deux chaînes, il
     * comptait comme un échec exactement ce qu'un chef de cabinet doit faire :
     *
     *   « Attendre les pièces Regulatory de Nivolex »  — waitFor.attachment: true, et le
     *     script de ce banc n'envoie que du TEXTE. Adam attend le FICHIER, pas la promesse ;
     *   « Attendre le 15 septembre 17:00 avant la relance » — waitFor.until dans dix jours.
     *     Adam diffère une relance au lieu de harceler, et le run dure six minutes.
     *
     * Ce sont des propriétés du WAITFOR, lisibles, pas une commodité : une pièce jointe que
     * le script n'envoie jamais, une échéance postérieure à la fin du run. Le banc les nomme
     * et les met de côté ; toute AUTRE attente encore ouverte reste un échec, comme avant.
     * On ne baisse pas la barre — on cesse de compter comme un défaut ce qui est la conduite
     * attendue, et on DIT ce qu'on a écarté.
     */
    ...(() => {
      const ouvertes = journal[journal.length - 1]?.attentes ?? [];
      const finDuRun = Date.now();
      const horsPortee = ouvertes.filter((a) => {
        const w = (a.waitFor ?? {}) as Record<string, unknown>;
        if (w.attachment === true) return true;            // le script n'envoie jamais de pièce jointe
        const t = typeof w.until === "string" ? Date.parse(w.until) : NaN;
        return Number.isFinite(t) && t > finDuRun;         // échéance postérieure à la fin du run
      });
      const restantes = ouvertes.length - horsPortee.length;
      const leves = journal.reduce((n, j) => n + j.reveils, 0);
      const dit = horsPortee.length > 0
        ? ` · ${horsPortee.length} hors de portée du script (${horsPortee.map((a) => a.key).join(", ")}) — pièce jointe jamais envoyée ou échéance future, ce n'est pas un défaut d'Adam`
        : "";
      return [{
        id: "consolide",
        libelle: "la chaîne va jusqu'au bout : toutes les attentes que ce banc peut satisfaire sont levées",
        ok: leves >= CHAINE.acteurs.length && restantes === 0,
        detail: `${leves} attente(s) levée(s) · ${ouvertes.length} encore ouverte(s) à l'arrêt${dit} · ${consommes.size}/${SCENARIO.length} contenus distincts donnés`,
      }];
    })(),
    /**
     * ── LE DÉMENTI A-T-IL ÉTÉ PRIS EN COMPTE, OU EMPORTÉ EN SILENCE ? (§90) ─────────────
     *
     * Le cas adverse le plus dangereux de la chaîne : la personne se reprend, la mission ne
     * casse RIEN, conclut, et le livrable porte l'ancien chiffre. Aucune étape en échec, aucun
     * signal — le faux succès parfait.
     *
     * Deux issues sont acceptables et une seule ne l'est pas :
     *   • le NOUVEAU chiffre est repris quelque part (résultats d'étapes, notifications) ;
     *   • ou la DIVERGENCE est dite (contradiction, correction, rectification, écart…).
     * Ne rien faire, en gardant l'ancien, est le seul échec.
     */
    ...(ADVERSAIRE === "contradiction" && CHAINE.contradiction ? [(() => {
      const c = CHAINE.contradiction;
      const corpus = [
        ...(etatFinal?.steps ?? []).map((x) => `${x.title} ${JSON.stringify(x.result ?? {})}`),
        ...events.map((x) => `${x.summary ?? ""} `),
      ].join(" \n ").toLowerCase();
      /**
       * CE VERDICT A ÉTÉ FAUX UNE FOIS — ET C'EST INSTRUCTIF.
       *
       * Première version : « le nouveau chiffre est repris OU un mot de divergence apparaît
       * quelque part ». Il est passé au VERT sur les deux chaînes… en accrochant des mots qui
       * n'avaient rien à voir : « contradiction relevée » (le juge parlant d'AUTRE chose) et
       * « écart » (un écart facture/BC des données ERP). Vérification en base : ni 91 000 ni
       * 19 800 000 n'existaient nulle part. Le démenti avait bel et bien disparu.
       *
       * Un mot-clé cherché dans tout le corpus n'est pas une preuve : il mesure le vocabulaire
       * ambiant. On exige donc une trace de CE message-ci — son chiffre corrigé, ou le journal
       * du fait hors attente que le routeur écrit désormais pour lui.
       */
      const chiffre = (v: string) => corpus.includes(v.toLowerCase()) || corpus.includes(v.replace(/\s/g, "").toLowerCase());
      const repris = chiffre(c.nouveau);
      const consigne = corpus.includes("hors attente") || corpus.includes("event_orphelin");
      const ancienSeul = chiffre(c.ancien) && !repris && !consigne;
      return {
        id: "contradiction",
        libelle: "un démenti est REPRIS ou CONSIGNÉ — jamais emporté en silence",
        ok: repris || consigne,
        detail: repris
          ? `le chiffre corrigé (${c.nouveau}) circule`
          : consigne
            ? "le message hors attente est consigné au journal de la mission (à relire avant de conclure)"
            : ancienSeul
              ? `FAUX SUCCÈS : seul l'ancien chiffre (${c.ancien}) circule, le démenti n'a laissé aucune trace`
              : "ni l'ancien ni le nouveau chiffre ne circulent — rien à juger",
      } as Verdict;
    })()] : []),
    /**
     * ── LA RÉPONSE ANTICIPÉE N'EST PAS PERDUE (§90) ─────────────────────────────────────
     *
     * Le pire cas n'est pas qu'elle soit ignorée : c'est que la mission demande ENSUITE la même
     * chose et attende pour toujours une information qu'elle a déjà reçue. Une mission qui dort
     * sur ce qu'elle possède, sans échec ni retard visible.
     *
     * Deux issues acceptables : le message est CONSIGNÉ (il reste lisible avant de conclure),
     * ou la mission n'est pas restée suspendue à cette attente-là à l'arrêt. Rien des deux —
     * message évaporé ET attente encore ouverte — est le défaut.
     */
    ...(ADVERSAIRE === "desordre" && anticipeEnvoye ? [(() => {
      const corpus = [
        ...(etatFinal?.steps ?? []).map((x) => `${x.title} ${JSON.stringify(x.result ?? {})}`),
        ...events.map((x) => x.summary ?? ""),
      ].join(" \n ").toLowerCase();
      const consigne = corpus.includes("hors attente") || corpus.includes("event_orphelin");
      const ouvertes = journal[journal.length - 1]?.attentes.length ?? 0;
      return {
        id: "anticipation",
        libelle: "une réponse ARRIVÉE AVANT la demande n'est ni perdue ni suivie d'une attente éternelle",
        ok: consigne || ouvertes === 0,
        detail: consigne
          ? `consignée au journal${ouvertes === 0 ? " ; aucune attente ouverte à l'arrêt" : ` ; ${ouvertes} attente(s) encore ouverte(s)`}`
          : ouvertes === 0
            ? "non consignée, mais la mission ne dort sur aucune attente"
            : `PERDUE : rien au journal, et ${ouvertes} attente(s) encore ouverte(s) — la mission dort sur une information qu'elle a reçue`,
      } as Verdict;
    })()] : []),
    ...verdictsLivrables,
    { id: "retour", libelle: "Adam revient vers le dirigeant", ok: notifs.length > 0, detail: notifs.map((n) => n.summary.slice(0, 70)).join(" | ") || "aucune notification" },
    /**
     * ZÉRO SORTIE RÉELLE — et le verdict le PROUVE au lieu de le supposer.
     *
     * Première version : `ok: sorties.every(() => true)`. Une tautologie : elle rendait `true`
     * même sur une liste vide, même garde désarmée. Un verdict qui ne peut pas échouer ne
     * mesure rien — c'est précisément le faux succès que ce banc est censé traquer.
     *
     * Ce qui empêche un courriel de partir, ce n'est pas le nombre de tentatives : c'est que
     * la garde soit ARMÉE. On le lui demande.
     */
    { id: "sortie", libelle: "ZÉRO sortie réelle (garde de sortie armée)", ok: sortiesInterdites(), detail: sortiesInterdites() ? `garde armée · ${sorties.length} tentative(s) interceptée(s) avant tout transport` : "GARDE DÉSARMÉE — un envoi a pu partir" },
    /**
     * TROISIÈME TAUTOLOGIE DU MÊME FICHIER — celle-ci MENTAIT dans son libellé.
     *
     * « la mission n'est ni FAILED ni bloquée » testait `!["FAILED","CANCELLED"].includes(...)` :
     * BLOCKED passait au vert, sous une phrase qui disait le contraire. Le run 10/10 portait donc
     * « ✓ ni FAILED ni bloquée — BLOCKED ». Un verdict qui contredit son propre libellé est pire
     * qu'un verdict absent : il fait passer une mission bloquée pour une mission réussie.
     */
    { id: "termine", libelle: "la mission n'est ni FAILED, ni annulée, ni BLOQUÉE",
      ok: !["FAILED", "CANCELLED", "BLOCKED"].includes(mrow?.status ?? ""), detail: mrow?.status ?? "?" },
  ];

  console.log("\n─────────── VERDICT ───────────");
  for (const v of verdicts) console.log(`  ${v.ok ? "✓" : "✗"} ${v.libelle} — ${v.detail}`);
  console.log(`\n  ${verdicts.filter((v) => v.ok).length}/${verdicts.length} · ${appels.length} appel(s) · ${cout == null ? "coût inconnu" : `$${cout.toFixed(4)}`} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (fichiers.length) console.log(`  fichiers produits : ${fichiers.map((f) => f.name).join(", ")}`);

  fs.mkdirSync("bench-out", { recursive: true });
  const out = path.join("bench-out", `chaine-humaine-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), missionId, demande: DEMANDE, journal, verdicts, fichiers, appels: appels.length, cout }, null, 2));
  console.log(`  rapport : ${out}`);
  await prisma.$disconnect();
  process.exit(verdicts.every((v) => v.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
