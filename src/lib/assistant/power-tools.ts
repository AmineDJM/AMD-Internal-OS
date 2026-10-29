import type { ClaudeToolDef } from "@/lib/ai";
import type { PowerTool } from "@/platform/ia/outil";
import { recordPermissionRefusal } from "@/lib/models/telemetry";
import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { getEnvelopes, getEnvelopesGrandTotal, getBudgetOverview } from "@/lib/queries/budget";
import { getComptaData } from "@/lib/queries/compta";
import { getRhData, getLeavesToDecide } from "@/modules/rh/api";
import { getActionCenter, PREFIXE_CONGE } from "@/lib/queries/action-center";
import { EXECUTIVE_TOOLS } from "@/lib/assistant/executive-tools";
import { WATCH_TOOLS } from "@/lib/assistant/watch-tools";
import { EXECUTIVE_READ_TOOLS } from "@/lib/assistant/executive-read-tools";

import { EXECUTIVE_BRIEF_TOOLS } from "@/lib/assistant/executive-brief-tools";
import { MEMORY_TOOLS } from "@/lib/assistant/memory-tools";
import { TEACH_TOOLS } from "@/lib/assistant/teach-tools";
import { THREE_SIXTY_TOOLS } from "@/lib/assistant/three-sixty";
import { BUSINESS_CAPABILITIES } from "@/lib/assistant/business-capabilities";
import { OFFICE_TOOLS } from "@/lib/assistant/office-capabilities";
import { DOCUMENT_DISCOVERY_TOOLS, KNOWLEDGE_TOOLS } from "@/lib/assistant/document-discovery";
import { SOURCE_MAP_TOOLS } from "@/lib/assistant/source-map";
import { QUALITY_TOOLS } from "@/lib/assistant/quality-tools";
import { SANDBOX_TOOLS } from "@/lib/assistant/sandbox-tools";
import { VIEW_TOOLS } from "@/lib/assistant/view-tools";
import { SKILL_TOOLS } from "@/lib/assistant/skill-tools";
import { INBOUND_TOOLS } from "@/lib/assistant/inbound-tools";
import { MEDIA_TOOLS } from "@/lib/assistant/media-tools";
import { CALCUL_TOOLS } from "@/lib/assistant/calcul-tools";
import { RESEAU_TOOLS } from "@/lib/assistant/reseau-tools";
import { FICHIERS_TOOLS } from "@/lib/assistant/fichiers-tools";
import { REGISTRE_TOOLS } from "@/lib/assistant/registre-tools";
import { MONDE_TOOLS } from "@/lib/assistant/monde-tools";
import { VERITE_TOOLS } from "@/lib/assistant/verite-tools";
import { OBJECTIF_TOOLS } from "@/lib/assistant/objectif-tools";
import { ANNULATION_TOOLS } from "@/lib/assistant/annulation-tools";
import { VERIFICATION_TOOLS } from "@/lib/assistant/verification-tools";
import { PLANCHE_TOOLS } from "@/lib/assistant/planche-tools";
import { executerOutilDynamique, labelsDynamiques, outilsDynamiquesPour } from "@/platform/in-process/skills";
import { INTELLIGENCE_TOOLS } from "@/lib/assistant/intelligence-tools";
import { SPECIALIST_TOOLS } from "@/lib/assistant/specialists/tools";
import { specialistesActifs } from "@/lib/assistant/specialists/registry";
import { WHAT_IF_TOOLS } from "@/lib/assistant/what-if";
import { DELIVERABLE_TOOLS } from "@/lib/assistant/deliverables";
import { CORPUS_TOOLS } from "@/lib/assistant/corpus-tools";
import { TIME_TRAVEL_TOOLS } from "@/lib/assistant/time-travel";
import { REGULATORY_READ_TOOLS } from "@/platform/ia/lectures/regulatory-read";
import { INVESTIGATION_TOOLS } from "@/lib/assistant/investigation";
import { ACTION_INTENT_TOOLS } from "@/platform/ia/intentions/action-intents";
import { WHAT_CHANGED_TOOLS } from "@/lib/assistant/what-changed";
import { ADAM_TOOLS } from "@/lib/assistant/adam-tools";
import { DIRECTORY_TOOLS } from "@/platform/ia/lectures/directory-tools";
import { SHOW_TOOLS } from "@/lib/assistant/show-tools";
import { WEB_RESEARCH_TOOLS } from "@/platform/ia/web-research";
import { resultatVide } from "@/platform/ia/lectures/empty-result";
import { sansBloquer } from "@/lib/journal";

/**
 * LES POUVOIRS DE L'ASSISTANT SONT **CEUX DE SON INTERLOCUTEUR** — ni plus, ni moins.
 *
 * L'assistant savait chercher un produit, un médecin, un événement… mais restait muet sur
 * l'argent : demander « où en est le budget Ad & Pro ? » ou « combien reste-t-il à encaisser ? »
 * renvoyait une invitation à ouvrir le module soi-même. Pour l'administrateur, qui voit tout
 * dans l'OS, c'était une amputation gratuite : l'assistant en savait moins que lui.
 *
 * La correction ne consiste PAS à ouvrir ces outils « à l'admin » : elle consiste à les ouvrir
 * **au droit**. Chaque outil déclare la permission qui l'active (`allowed`), lue dans la
 * matrice d'accès EFFECTIVE — celle-là même qui régit les pages. Un compte à qui le Super Admin
 * ouvre les Budgets gagne l'outil budget dans la seconde, sans toucher au code ; un compte à
 * qui on les ferme le perd tout aussi vite. Et les requêtes appelées ici sont **exactement**
 * celles des pages (`getBudgetOverview`, `getComptaData`, `getRhData`…), qui refiltrent
 * elles-mêmes par enveloppe visible et par entité : impossible de contourner un cloisonnement
 * en passant par la conversation.
 */

export type { PowerTool } from "@/platform/ia/outil";

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

/** Arrondi à l'unité : le modèle n'a que faire des centimes, et ça allège le contexte. */
const dzd = (n: number): number => Math.round(n);

/**
 * UN BLOC DE JAUGES, prêt à traverser jusqu'à l'écran (`_blocs`, voir `workspace/compose.ts`).
 *
 * Les jauges à zéro sont ÉCARTÉES : une enveloppe non encore dotée produit une barre vide qui
 * occupe une ligne sans rien dire. Le seuil, lui, est calculé ici plutôt qu'à l'écran — c'est
 * une règle de gestion (85 % = attention, 100 % = dépassement), pas une décision de style.
 */
function gaugesBlock(
  title: string,
  rows: { label: string; valeur: number; total: number; unite?: string; detail?: string }[],
): Record<string, unknown> {
  return {
    kind: "progress",
    title,
    gauges: rows
      .filter((r) => r.total > 0)
      .map((r) => {
        const pct = (r.valeur / r.total) * 100;
        return {
          ...r,
          ton: pct >= 100 ? "alerte" : pct >= 85 ? "attention" : "neutre",
        };
      }),
  };
}

export const POWER_TOOLS: PowerTool[] = [
  {
    def: {
      name: "read_budget",
      description:
        "Lit le BUDGET : enveloppes visibles par l'utilisateur avec montant total, alloué, consommé, restant et taux de consommation. " +
        "Sans `envelope`, renvoie la synthèse de TOUTES les enveloppes visibles (utiliser pour « où en est le budget ? », « combien reste-t-il ? »). " +
        "Avec `envelope` (nom ou fragment de nom), renvoie le DÉTAIL de cette enveloppe : postes/catégories, consommé par poste, dépenses non imputées. " +
        "Ne jamais inventer un montant : si l'enveloppe est introuvable ou fermée à l'utilisateur, le dire.",
      input_schema: {
        type: "object",
        properties: {
          envelope: { type: "string", description: "Nom (ou fragment) de l'enveloppe pour en obtenir le détail. Omettre pour la synthèse générale." },
        },
      },
    },
    allowed: (u) => userCan(u, "BUDGETS", "VIEW"),
    label: "Budget consulté",
    run: async (input, user) => {
      const wanted = str(input, "envelope");
      const envelopes = await getEnvelopes(user);
      if (envelopes.length === 0) return "Aucune enveloppe budgétaire ne vous est ouverte.";

      if (!wanted) {
        const total = await getEnvelopesGrandTotal(user);
        return JSON.stringify({
          enveloppesVisibles: total.count,
          totalDzd: dzd(total.total),
          alloueDzd: dzd(total.allocated),
          consommeDzd: dzd(total.consumed),
          restantDzd: dzd(total.remaining),
          parEnveloppe: total.items.map((e) => ({
            nom: e.name, totalDzd: dzd(e.total), consommeDzd: dzd(e.consumed), restantDzd: dzd(e.remaining),
          })),
          // « Il reste combien ? » se répond par une LONGUEUR. Un pourcentage écrit dans une
          // phrase se relit ; une barre presque pleine se comprend sans effort — et la réponse
          // en texte peut alors tenir en un montant, comme le PDG l'a demandé.
          _blocs: [gaugesBlock("Consommation des enveloppes", total.items.map((e) => ({
            label: e.name, valeur: dzd(e.consumed), total: dzd(e.total), unite: "DZD",
            detail: `reste ${new Intl.NumberFormat("fr-DZ").format(dzd(e.remaining))} DZD`,
          })))],
        });
      }

      const needle = wanted.toLowerCase();
      const match = envelopes.find((e) => e.name.toLowerCase().includes(needle));
      if (!match) {
        return `Aucune enveloppe « ${wanted} » parmi celles qui vous sont ouvertes : ${envelopes.map((e) => e.name).join(", ")}.`;
      }
      const ov = await getBudgetOverview(user, match.id);
      if (!ov) return `L'enveloppe « ${match.name} » ne vous est pas ouverte.`;
      // Chaque poste comprend ses sous-catégories — les mêmes chiffres que l'écran.
      // (une sous-catégorie ne se rattache qu'à une catégorie de tête).
      const cats = ov.categories.map((c) => {
        const consumed = c.consumed + ov.categories.filter((s) => s.parentId === c.id).reduce((a, s) => a + s.consumed, 0);
        return { ...c, consumed, remaining: c.allocated - consumed };
      });
      return JSON.stringify({
        enveloppe: ov.envelope.name,
        periode: { du: ov.period.from.slice(0, 10), au: ov.period.to.slice(0, 10) },
        totalDzd: dzd(ov.totals.total),
        alloueDzd: dzd(ov.totals.allocated),
        nonAlloueDzd: dzd(ov.totals.unallocated),
        consommeDzd: dzd(ov.totals.consumed),
        engageDzd: dzd(ov.totals.committed),
        restantDzd: dzd(ov.totals.remaining),
        tauxConsommationPct: ov.totals.pct,
        postes: cats.map((c) => ({
          nom: c.name, alloueDzd: dzd(c.allocated), consommeDzd: dzd(c.consumed), restantDzd: dzd(c.remaining),
        })),
        depensesNonImputees: { nombre: ov.unattributed.count, montantDzd: dzd(ov.unattributed.total) },
        _blocs: [gaugesBlock(`${ov.envelope.name} — consommation`, [
          { label: "Enveloppe entière", valeur: dzd(ov.totals.consumed), total: dzd(ov.totals.total), unite: "DZD",
            detail: `reste ${new Intl.NumberFormat("fr-DZ").format(dzd(ov.totals.remaining))} DZD` },
          ...cats.map((c) => ({
            label: c.name, valeur: dzd(c.consumed), total: dzd(c.allocated), unite: "DZD",
            detail: `reste ${new Intl.NumberFormat("fr-DZ").format(dzd(c.remaining))} DZD`,
          })),
        ])],
      });
    },
  },
  {
    def: {
      name: "read_finances",
      description:
        "Lit la situation FINANCIÈRE de l'entité en cours : recettes et dépenses du mois, résultat, montant à encaisser, ordres de dépense à régler, retards, " +
        "décaissements à venir (salaires à part) et les principales catégories. À utiliser pour « où en est la trésorerie ? », « qu'est-ce qu'on doit payer ? », « qui nous doit de l'argent ? ».",
      input_schema: { type: "object", properties: {} },
    },
    allowed: (u) => userCan(u, "FINANCES", "VIEW"),
    label: "Situation financière consultée",
    run: async (_input, user) => {
      const d = await getComptaData(user.id);
      return JSON.stringify({
        recettesDuMoisDzd: dzd(d.recettesMois),
        depensesDuMoisDzd: dzd(d.depensesMois),
        resultatDuMoisDzd: dzd(d.resultatMois),
        aEncaisserDzd: dzd(d.aEncaisser),
        aReglerDzd: dzd(d.aReglerOrders),
        aReglerNombre: d.aReglerCount,
        enRetard: { nombre: d.enRetardCount, montantDzd: dzd(d.enRetardMontant) },
        decaissementsAVenir: {
          salairesDzd: dzd(d.depensesSalairesTotal),
          autresDzd: dzd(d.depensesAutresTotal),
        },
        depensesParCategorie: d.depByCat.slice(0, 8).map((c) => ({ categorie: c.category, montantDzd: dzd(c.amount) })),
        recettesParCategorie: d.recByCat.slice(0, 8).map((c) => ({ categorie: c.category, montantDzd: dzd(c.amount) })),
        aReglerDetail: d.ordersPending.slice(0, 15).map((o) => ({
          reference: o.reference, libelle: o.label, montantDzd: dzd(o.amount),
          beneficiaire: o.counterparty, echeance: o.date?.slice(0, 10) ?? null, enRetard: o.overdue,
        })),
      });
    },
  },
  {
    def: {
      name: "read_hr_overview",
      description:
        "Lit la situation RH : effectif total et actif, masse salariale du dernier mois de paie (avec sa source), congés en attente, avances sur salaire en attente, " +
        "contrats arrivant à échéance sous 60 jours, répartition par département ET PAR ENTITÉ. À utiliser pour « combien sommes-nous ? », « combien de salariés chez Adventum ? », " +
        "« quelle est la masse salariale ? », « quels contrats expirent ? ». " +
        "⚠️ Le groupe compte PLUSIEURS sociétés. La réponse porte toujours un champ `perimetre` : citez-le. " +
        "Sans `entite`, les totaux couvrent TOUTE la plateforme, sociétés confondues — ne les attribuez alors à AUCUNE société en particulier ; " +
        "la ventilation `parEntite` donne le chiffre de chacune.",
      input_schema: {
        type: "object",
        properties: {
          entite: { type: "string", description: "Nom ou nom court de la société (« Adventum », « Pharmagène »). Omettre pour tout le groupe." },
        },
      },
    },
    allowed: (u) => userCan(u, "RH", "VIEW"),
    label: "Situation RH consultée",
    run: async (input, user) => {
      const d = await getRhData(user.id);
      const parEntite = d.byCompany.map((c) => ({
        entite: c.label, effectifActif: c.active, effectifTotal: c.total, masseSalarialeDzd: dzd(c.masseSalariale),
      }));

      // LA PORTÉE DEMANDÉE, RÉSOLUE SUR CE QUI EXISTE VRAIMENT — nom court ou raison sociale.
      // Un nom qu'on ne reconnaît pas ne produit PAS d'erreur : on rend le groupe entier en
      // nommant les sociétés disponibles. Une réponse trop large se corrige d'un mot ; un
      // chiffre attribué à la mauvaise société, non.
      const want = str(input, "entite");
      const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
      const hit = want
        ? d.byCompany.find((c) => fold(c.label) === fold(want) || (c.fullName != null && fold(c.fullName) === fold(want)))
          ?? d.byCompany.find((c) => fold(c.label).includes(fold(want)) || (c.fullName != null && fold(c.fullName).includes(fold(want))))
        : undefined;

      if (hit) {
        return JSON.stringify({
          perimetre: `${hit.label} uniquement`,
          entite: hit.label,
          effectifTotal: hit.total,
          effectifActif: hit.active,
          masseSalarialeDzd: dzd(hit.masseSalariale),
          masseSalarialeSource: d.stats.masseSalarialeSource,
          parEntite,
          // Ces trois-là ne se ventilent pas par société : on le DIT plutôt que de laisser croire
          // qu'ils suivent le filtre.
          congesEnAttente: d.stats.pending,
          avancesEnAttente: d.stats.advances,
          portéeDesCongesEtAvances: "toutes entités confondues",
          contratsExpirantSous60j: d.contractsExpiring.map((e) => ({
            nom: e.fullName, fin: e.contractEnd?.toISOString().slice(0, 10) ?? null,
          })),
        });
      }

      return JSON.stringify({
        perimetre: parEntite.length > 1
          ? `TOUTE LA PLATEFORME — ${parEntite.length} entités confondues (${parEntite.map((c) => c.entite).join(", ")})`
          : "toute la plateforme",
        ...(want ? { entiteDemandeeIntrouvable: `« ${want} » ne correspond à aucune société : ${parEntite.map((c) => c.entite).join(", ")}.` } : {}),
        effectifTotal: d.stats.total,
        effectifActif: d.stats.active,
        parEntite,
        masseSalarialeDzd: dzd(d.stats.masseSalariale),
        masseSalarialeSource: d.stats.masseSalarialeSource,
        congesEnAttente: d.stats.pending,
        avancesEnAttente: d.stats.advances,
        contratsExpirantSous60j: d.contractsExpiring.map((e) => ({
          nom: e.fullName, fin: e.contractEnd?.toISOString().slice(0, 10) ?? null,
        })),
        parDepartement: d.byDepartment,
      });
    },
  },
  {
    def: {
      name: "list_pending_decisions",
      description:
        "Liste TOUT ce qui attend une décision ou une action DE L'UTILISATEUR, tous modules confondus : validations, dossiers Regulatory, demandes administratives, " +
        "congés à trancher… À utiliser pour « qu'est-ce qui m'attend ? », « qu'est-ce que je dois valider ? », « qu'ai-je en retard ? ». " +
        "Chaque ligne porte son module, son statut et son lien interne — les citer pour que l'utilisateur puisse cliquer.",
      input_schema: {
        type: "object",
        properties: { limit: { type: "number", description: "Nombre maximum de lignes (défaut 25, max 60)." } },
      },
    },
    allowed: () => true,
    label: "File de décisions consultée",
    run: async (input, user) => {
      const rawLimit = typeof input.limit === "number" ? input.limit : 25;
      const limit = Math.max(1, Math.min(60, Math.round(rawLimit)));
      const [center, leaves] = await Promise.all([
        getActionCenter(user),
        getLeavesToDecide(user).catch(sansBloquer("power-tools.run.getLeavesToDecide", [])),
      ]);
      // Les congés du centre sont écartés : ils sont relus juste en dessous, avec leurs gestes. Depuis le lot E2
      // le centre les porte aussi — sans ce filtre, chaque congé serait listé, et compté, deux fois.
      const items = center.items.filter((i) => !i.objet.startsWith(PREFIXE_CONGE)).slice(0, limit).map((i) => ({
        titre: i.title, detail: i.subtitle, module: i.module, statut: i.statusLabel,
        echeance: i.deadline ? i.deadline.slice(0, 10) : null, lien: i.href,
        // LES GESTES VOYAGENT AVEC LA LIGNE. Sans eux, la file ne sait dire que « ouvre l'autre
        // écran » — ce que le PDG a refusé trois fois de suite.
        ...(i.actions?.length ? { actions: i.actions } : {}),
      }));
      const conges = leaves.map((l) => ({
        titre: `Congé — ${l.employee}`, detail: `${l.days} j`, module: "Ressources humaines",
        statut: l.stage === "MANAGER" ? "À valider (vous, N+1)" : l.stage === "HR" ? "À valider (RH)" : "À valider (Direction)",
        echeance: l.startDate.slice(0, 10), lien: "/mon-espace",
        // `getLeavesToDecide` ne rend QUE les demandes que cette personne peut trancher à cette
        // marche du circuit (N+1 → RH → Direction) : elles sont donc toutes décidables.
        actions: [
          { libelle: "Accorder", phrase: `Approuve le congé de ${l.employee}`, ton: "primaire" as const },
          { libelle: "Refuser", phrase: `Refuse le congé de ${l.employee}`, ton: "danger" as const },
        ],
      }));
      // ZÉRO EST UN COMPTE (`empty-result.ts`) : « rien n'attend » doit être MESURÉ pour
      // qu'une mission puisse s'en servir comme constat, et pas seulement le lire.
      if (items.length === 0 && conges.length === 0) return resultatVide("Rien n'attend votre décision pour l'instant.");
      const elements = [...conges, ...items];
      return JSON.stringify({ items: elements, count: elements.length, total: elements.length, elements });
    },
  },
  // LES OUTILS EXÉCUTIFS — « My Chief of Staff » (PDG + Super Admin) : fouille et lecture du
  // Drive, histoire complète d'un dossier, bilan d'une personne, rappels planifiés. Ils vivent
  // dans leur module (executive-tools.ts) et passent par la MÊME porte que les autres :
  // `allowed` revérifié à chaque appel par executePowerTool.
  ...EXECUTIVE_TOOLS,
  ...WATCH_TOOLS,
  // Les LECTURES TRANSVERSES (recherche fédérée, calendrier, stocks, hôpitaux, paie, courriers,
  // agrégats financiers) — chacune ouverte par le DROIT de l'écran correspondant.
  ...EXECUTIVE_READ_TOOLS,
  // La recherche DANS le contenu — le pendant de `search_everything`, qui n'en lit aucun.
  // Le PILOTAGE PROACTIF : signaux d'alerte, point exécutif, rapport consolidé (.docx → Drive).
  ...EXECUTIVE_BRIEF_TOOLS,
  // MÉMOIRE, DÉCISIONS, ENGAGEMENTS : les registres PERSONNELS (mémoire typée, archives de
  // conversation ouvertes à tous car strictement cloisonnées par user.id ; registres de
  // décisions et d'engagements au siège exécutif). Écriture directe : rien ici ne touche
  // le monde extérieur — c'est la frontière avec ACTION_POLICY.
  ...MEMORY_TOOLS,
  // TEACH ADAM (§119) : les RÈGLES enseignées — périmètre personnel ouvert à tous (borné à
  // `user.id`), périmètres département / société gardés dans le pont par le droit de poser des
  // directives. Écriture directe, jamais un effet externe.
  ...TEACH_TOOLS,
  // Les VUES 360° (collaborateur, produit, fournisseur) et les INSIGHTS (organisation,
  // délais réels des circuits) — le backend calcule, chaque chiffre porte sa provenance.
  ...THREE_SIXTY_TOOLS,
  // Les CAPACITÉS MÉTIER : une question d'affaires, un appel. Elles s'appuient sur les
  // relations canoniques du produit (clés étrangères, pas correspondance de libellés) et sur
  // la couche sémantique, si bien qu'elles remplacent une SÉQUENCE d'outils au lieu d'en
  // ajouter à la liste.
  ...BUSINESS_CAPABILITIES,
  ...OFFICE_TOOLS,
  // Les LECTURES REGULATORY CANONIQUES : charge par personne (assignation DIRECTE ≠ accès),
  // portefeuille par partenaire (résolution de graphies/acronymes) — le MÊME périmètre que
  // l'écran (`regulatoryVisibleWhere`), pour que le Chief ne contredise jamais le tableau.
  ...REGULATORY_READ_TOOLS,
  // Les INVESTIGATIONS : événement reconstitué depuis TOUTES ses traces (8 sources en
  // parallèle, acronymes résolus, couverture rendue) ; dossier Drive exploré RÉCURSIVEMENT
  // en un tour (déposants réels, BC stricts ≠ assimilés, ACL nœud par nœud).
  ...INVESTIGATION_TOOLS,
  // La DÉCOUVERTE DOCUMENTAIRE en Drive « sale » : nom + index textuel progressif + lecture
  // bornée de vérification — le nom d'un fichier est un indice, pas une preuve.
  ...DOCUMENT_DISCOVERY_TOOLS,
  // La recherche DANS le contenu — le pendant de `search_everything`, qui n'en lit aucun.
  ...KNOWLEDGE_TOOLS,
  // LA CARTE DES SOURCES (fabric F3) : où vit chaque famille d'information, qui fait autorité,
  // et jusqu'à quand les sources dérivées sont synchronisées. Consulter avant de fouiller.
  ...SOURCE_MAP_TOOLS,
  // LA QUALITÉ DES DONNÉES (mandat 4 §23) : les anomalies trouvées par le moteur, classées, sous les droits.
  ...QUALITY_TOOLS,
  // LE BAC À SABLE (mandat 4 §25) : SQL en lecture seule (vue globale), analyse par étapes vérifiées,
  // code isolé, conseil de visualisation. Rien n'écrit.
  ...SANDBOX_TOOLS,
  ...VIEW_TOOLS,
  ...SKILL_TOOLS,
  // LES FAITS EXTERNES (mandat 5 §37) : ce que l'ingestion universelle a reçu, et la levée de doute par une personne.
  ...INBOUND_TOOLS,
  // L'AUDIO ET LA VIDÉO (mandat 5 §38) : transcription horodatée, locuteurs, structure, recherche de l'instant, images d'une vidéo.
  ...MEDIA_TOOLS,
  ...CALCUL_TOOLS,
  ...RESEAU_TOOLS,
  ...FICHIERS_TOOLS,
  ...REGISTRE_TOOLS,
  ...MONDE_TOOLS,
  ...VERITE_TOOLS,
  ...OBJECTIF_TOOLS,
  ...ANNULATION_TOOLS,
  ...VERIFICATION_TOOLS,
  ...PLANCHE_TOOLS,
  ...INTELLIGENCE_TOOLS,
  // §29 — « aucun sans bénéfice mesuré » : l'outil de délégation n'entre au registre que si au
  // moins un spécialiste a une mesure POSITIVE. Un outil qui refuserait toujours serait une
  // capacité sans appelant réel (§118.14) ; un outil absent ne coûte ni jeton ni confusion.
  ...(specialistesActifs().length > 0 ? SPECIALIST_TOOLS : []),
  // SIMULATION (jamais mutative), ÉTAT CONSOLIDÉ de l'entreprise, tri de l'ATTENTION du PDG.
  ...WHAT_IF_TOOLS,
  // LIVRABLES UNIVERSELS : vrais .docx/.xlsx/.pptx depuis UNE spec (cohérence par construction),
  // registre versionné, dépôt au Drive.
  ...DELIVERABLE_TOOLS,
  // Le CORPUS DE CONNAISSANCE (textes juridiques vérifiés) : recherche sourcée, lecture
  // d'article, inventaire — et l'honnêteté du corpus vide (« pas assez de sources vérifiées »).
  ...CORPUS_TOOLS,
  // TIME TRAVEL : l'état PASSÉ d'un dossier à une date, reconstruit du journal d'audit —
  // strictement lecture seule, avec le « avant / maintenant » dans la même réponse.
  ...TIME_TRAVEL_TOOLS,
  // L'HISTORIQUE CANONIQUE des actions de l'assistant (machine d'état serveur) — la seule
  // source de vérité pour « déjà demandé ? » / « c'est envoyé ? ». Cloisonné par compte.
  ...ACTION_INTENT_TOOLS,
  // WHAT CHANGED / CATCH ME UP : les changements significatifs d'un dossier depuis une date,
  // qui a agi, et l'état actuel en face — lecture seule.
  ...WHAT_CHANGED_TOOLS,
  // ADAM — les sens et les mains du Chief sur ses canaux (Gmail, agenda, Drive Google,
  // bureautique, missions). Meme cerveau, memes portes : ce sont des PowerTools comme les autres.
  ...ADAM_TOOLS,
  ...DIRECTORY_TOOLS,
  // LE WEB — la seule fenêtre sur l'EXTÉRIEUR : synthèse sourcée via l'outil natif du
  // fournisseur, provenance toujours dite (EXTERNE vs mémoire du modèle). Jamais pour l'ERP.
  ...WEB_RESEARCH_TOOLS,
  // MONTRER (et non lire) : un PDF, un contrat, un classeur mis sous les yeux, dans la
  // conversation. Le droit se juge document par document — voir `show-tools.ts`.
  ...SHOW_TOOLS,
];

/** Les outils réellement ouverts à CETTE personne — évalués à chaque conversation. */
export function powerToolsFor(user: CurrentUser): ClaudeToolDef[] {
  // LES OUTILS DYNAMIQUES (§36) — connecteurs, micro-outils, playbooks — viennent du pont des skills,
  // déjà filtrés par le droit que leur manifeste déclare ; préchargés au début du tour.
  return [...POWER_TOOLS.filter((t) => t.allowed(user)).map((t) => t.def), ...outilsDynamiquesPour(user).filter((t) => t.allowed(user)).map((t) => t.def)];
}

/** Libellés de trace des outils ouverts (pour l'UI « ce que l'assistant a consulté »). */
export function powerToolLabels(): Record<string, string> {
  return { ...labelsDynamiques(), ...Object.fromEntries(POWER_TOOLS.map((t) => [t.def.name, t.label])) };
}

/**
 * Exécute un outil de pouvoir. Renvoie `null` si le nom n'en est pas un (l'appelant continue
 * son propre aiguillage). La permission est **revérifiée ici** : la liste envoyée au modèle
 * n'est pas une garantie, c'est une suggestion — seul ce contrôle fait foi.
 */
export async function executePowerTool(
  name: string,
  input: Record<string, unknown>,
  user: CurrentUser,
): Promise<string | null> {
  const tool = POWER_TOOLS.find((t) => t.def.name === name);
  if (!tool) {
    // Un skill dynamique (§36) : le pont revérifie le droit du manifeste et exécute ; `null` sinon.
    try { return await executerOutilDynamique(name, input, user); } catch (err) {
      console.error(`[assistant] skill ${name} failed`, err);
      const cause = err instanceof Error && err.message.trim() !== "" ? ` Cause technique : ${err.message.slice(0, 220)}` : "";
      return `Le skill « ${name} » a échoué.${cause}`;
    }
  }
  if (!tool.allowed(user)) {
    // LA DÉCISION DE PERMISSION EST OBSERVÉE (§33) : refusée, nommée, comptée sur le tour.
    recordPermissionRefusal(name);
    return tool.refus ?? "Ce module ne vous est pas ouvert : je ne peux pas consulter cette information.";
  }
  try {
    return await tool.run(input, user);
  } catch (err) {
    console.error(`[assistant] power tool ${name} failed`, err);
    // La CAUSE reste dans la phrase — sans elle, un run Render a vu le moteur de missions
    // retenter trois fois un stockage qui répondait 402 (facturation), parce que le motif
    // avait été avalé ICI. Les messages du stockage ne portent ni clé ni signature (c'est
    // une propriété de `s3Failure`), et la conversation gagne à pouvoir DIRE pourquoi.
    const cause = err instanceof Error && err.message.trim() !== "" ? ` Cause technique : ${err.message.slice(0, 220)}` : "";
    return `La lecture a échoué (donnée indisponible). Je préfère ne rien avancer plutôt que d'inventer un chiffre.${cause}`;
  }
}

