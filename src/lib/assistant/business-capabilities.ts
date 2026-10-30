import type { PowerTool } from "@/platform/ia/outil";
import { inProcessPlatform, principalOf, peutPiloterMissionsAdam, REFUS_MISSIONS_ADAM } from "@/platform/in-process/adapter";

/**
 * LE REFUS DES OUTILS DE MISSION, écrit pour le MODÈLE (§118.30) : la règle, puis ce qui reste à
 * sa portée. Sans le second membre, il irait chercher l'outil dans le catalogue — il n'y est pas.
 */
const REFUS_MISSIONS_MODELE = `${REFUS_MISSIONS_ADAM} Propose à la place ce qui reste ouvert : un rappel daté `
  + "(plan_reminder), une tâche assignée (create_task) ou un engagement au registre (record_commitment) — et dis-le à la personne.";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CAPACITÉS MÉTIER — une question, un appel.
 *
 * ── CE QUE C'EST, ET CE QUE CE N'EST PAS ─────────────────────────────────────────────────
 *
 * Ce ne sont pas des outils de plus. Le registre en compte déjà plus de cent, et en ajouter
 * huit rendrait Adam plus lent, pas plus intelligent. Chaque capacité ici REMPLACE une SÉQUENCE
 * que le modèle devait sinon conduire lui-même, en plusieurs allers-retours, avec à chaque pas
 * un risque de rapprochement au jugé sur des libellés texte.
 *
 * Le critère d'admission est donc strict : une capacité n'entre que si elle répond à une
 * question qu'AUCUN outil existant ne sait traiter en un appel, et qu'elle s'appuie sur des
 * relations RÉELLES (clés étrangères) plutôt que sur une correspondance de noms.
 *
 * ── CE QUI A ÉTÉ ÉCARTÉ, ET POURQUOI ─────────────────────────────────────────────────────
 *
 * « Dossiers réglementaires bloqués » n'est pas ici : `regulatory_portfolio` et
 * `regulatoryExecutiveState` le calculent déjà, et un second chemin vers le même fait est
 * exactement ce qui fait diverger deux réponses à la même question.
 * « Créances » non plus : `finance_totals` et `read_finances` couvrent la trésorerie, et la
 * créance PAR PRODUIT est déjà rendue par `product_economics` ci-dessous.
 *
 * ── POURQUOI CE FICHIER NE TOUCHE PAS L'ERP ──────────────────────────────────────────────
 *
 * Première version écrite : elle importait `queries/product-360`, `queries/pch-360`,
 * `queries/metrics` et `products/resolve` en direct. `boundary.test.ts` a échoué immédiatement
 * — 428 franchissements pour un plafond de 424 — et son message donnait le remède : « le besoin
 * est vraiment nouveau → l'ajouter au CONTRAT ». C'est ce qui a été fait : deux lectures
 * (`product.economics`, `pch.market-status`) sont entrées dans `PlatformQuery`, et tout le
 * travail vit désormais dans l'adaptateur, côté ERP.
 *
 * Le résultat n'est pas seulement conforme, il est meilleur : Adam ne sait pas qu'il existe un
 * produit canonique, une couche de métriques, ni cinq définitions du mot « chiffre d'affaires ».
 * Il pose une question métier et reçoit une vue. Le jour où Adam devient un service à part, ces
 * deux capacités partent sans une ligne à changer.
 *
 * ── LA PORTE : VUE GLOBALE, ET PAS UN MODULE ─────────────────────────────────────────────
 *
 * Première version : `REGULATORY:VIEW` pour l'économie d'un produit, `PCH:VIEW` pour l'état
 * d'un marché. Ça paraissait juste — chaque capacité gardée par le module dont elle parle.
 *
 * C'était FAUX, et l'audit hostile l'a montré. Ces capacités ne parlent pas d'un module : elles
 * TRAVERSENT. `product_economics` rend le chiffre d'affaires encaissé, la créance ouverte, le
 * coût humain analytique et l'investissement promotionnel — c'est-à-dire de la finance et de la
 * RH — à quiconque possède `REGULATORY:VIEW`, ce qu'a n'importe quel assistant réglementaire.
 * La séquence d'outils qu'elles remplacent, elle, était gardée outil par outil : chacun refusait
 * ce que l'appelant n'avait pas le droit de lire. En la condensant, on avait condensé les portes.
 *
 * Et le CLOISONNEMENT PAR ENTITÉ ne peut pas non plus être tenu ici : le `Principal` du contrat
 * ne porte pas les sociétés de l'appelant, à dessein — Adam ne raisonne pas sur le RBAC. Une
 * capacité qui agrège sur toute la base ne peut donc s'ouvrir qu'à qui voit déjà toute la base.
 *
 * La porte est donc la VUE GLOBALE (PDG, Super Admin, direction), plus le module concerné comme
 * plancher. C'est plus restrictif que ce que la mission demandait, et c'est volontaire : §45 dit
 * qu'Adam est un outil de direction. Un employé garde ses écrans métier, qui sont cloisonnés.
 *
 * ── LE NOM DES OUTILS ────────────────────────────────────────────────────────────────────
 *
 * Les capacités ont été spécifiées en `product.getEconomics`, `pch.getMarketStatus`. Le point
 * est INTERDIT dans un nom d'outil côté fournisseur (`^[a-zA-Z0-9_-]{1,64}$`) : elles sont donc
 * nommées en `snake_case`, dans la convention déjà en place (`product_360`, `employee_360`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

/**
 * QUI PEUT INTERROGER UNE VUE TRANSVERSE.
 *
 * Vue globale OU Super Admin, ET le module concerné. Le module seul ne suffit pas : ces
 * capacités agrègent finance, RH et réglementaire en une réponse, et aucune d'elles ne sait
 * cloisonner par entité — le contrat ne transporte pas les sociétés de l'appelant.
 */
const vueTransverse = (u: Parameters<PowerTool["allowed"]>[0], module: string): boolean => {
  const p = principalOf(u);
  const global = p.capabilities.has("platform:global-view") || p.capabilities.has("platform:super-admin");
  return global && p.capabilities.has(`${module}:VIEW`);
};

export const BUSINESS_CAPABILITIES: PowerTool[] = [
  // ───────────────────────── L'ÉCONOMIE D'UN PRODUIT ─────────────────────────
  {
    def: {
      name: "product_economics",
      description:
        "COMBIEN UN PRODUIT RAPPORTE ET COÛTE, en un appel (« le produit X est-il rentable ? », « combien a-t-on encaissé "
        + "sur Y ? », « qui le porte et pour quel coût ? »). Rend, chacun avec SA DÉFINITION : chiffre d'affaires attribué "
        + "sur marchés, commandé, ENCAISSÉ, créances ouvertes, investissement promotionnel imputé, coût humain analytique, "
        + "contribution, retard réglementaire, fréquence de visite — plus le portefeuille (qui porte le produit, depuis quand, "
        + "pour quelle quotité) et les marchés PCH où il est nommé. "
        + "REMPLACE la séquence product_360 + read_finances + sales_operation + adpro_operation + read_hr_overview, et le "
        + "rapprochement par LIBELLÉ qu'elle imposait. Un montant indisponible rend `null` avec sa raison — jamais zéro. "
        + "Si la mention désigne plusieurs produits, rend la QUESTION à poser plutôt que de trancher.",
      input_schema: {
        type: "object",
        properties: {
          produit: { type: "string", description: "Référence PRD-…, alias, ou DCI + dosage (« nivolumab 100 mg »)." },
        },
        required: ["produit"],
      },
    },
    // LES DROITS RESTENT CEUX DE L'ERP. La capacité ne crée aucun accès : elle compose des
    // lectures que l'appelant pouvait déjà faire, et le contrat revérifie de son côté.
    allowed: (u) => vueTransverse(u, "REGULATORY"),
    label: "Économie d'un produit",
    run: async (input, user) => {
      const mention = str(input, "produit");
      if (mention.length < 2) return "Donnez la référence, l'alias ou la DCI du produit.";

      const r = await inProcessPlatform.query(principalOf(user), { kind: "product.economics", mention });
      if (r.kind !== "product.economics") return "Réponse inattendue de la plateforme.";
      // La question remonte TELLE QUELLE : elle est déjà rédigée pour être lue à l'humain.
      if (!r.data) return r.question ?? "Produit introuvable.";
      // La vue 360 est un RANGEMENT des champs qui suivent — métriques, portefeuille, marchés,
      // ventes, limites. Le modèle a les faits ; l'écran a la mise en forme.
      return JSON.stringify({ ...r.data, _blocsDecoratifs: true });
    },
  },

  // ───────────────────────── L'ÉTAT D'UN MARCHÉ PCH ─────────────────────────
  {
    def: {
      name: "pch_market_status",
      description:
        "OÙ EN EST UN MARCHÉ PCH, de la soumission à l'encaissement, en un appel (« où en est l'AO-2025-14 ? », "
        + "« combien nous doit encore la PCH sur ce marché ? »). Rend les CINQ MONTANTS QUI NE SE CONFONDENT PAS — attribué, "
        + "commandé, livré, encaissé, reste à encaisser — chacun avec sa définition ; l'état de la CAUTION et son échéance ; "
        + "les lignes avec leur produit canonique et leur taux de réalisation ; les bons en retard d'arrivée. "
        + "Les ventes enregistrées par les commerciaux sont rendues À PART et JAMAIS additionnées aux bons de commande : "
        + "les cumuler doublerait le chiffre d'affaires du marché. Accepte l'identifiant ou la référence.",
      input_schema: {
        type: "object",
        properties: {
          marche: { type: "string", description: "Référence du marché (« AO-2025-014 ») ou identifiant." },
        },
        required: ["marche"],
      },
    },
    allowed: (u) => vueTransverse(u, "PCH"),
    label: "État d'un marché PCH",
    run: async (input, user) => {
      const reference = str(input, "marche");
      if (reference.length < 2) return "Donnez la référence du marché.";

      const r = await inProcessPlatform.query(principalOf(user), { kind: "pch.market-status", reference });
      if (r.kind !== "pch.market-status") return "Réponse inattendue de la plateforme.";
      if (!r.data) return r.question ?? "Marché introuvable.";
      return JSON.stringify({ ...r.data, _blocsDecoratifs: true });
    },
  },

  // ───────────────────────── L'HISTOIRE D'UNE AFFAIRE ─────────────────────────
  /**
   * « RETRACE-MOI X » — et pourquoi le modèle NE CONSTRUIT PAS la frise.
   *
   * Une chronologie inventée est indétectable : elle a l'air d'une chronologie. Un jalon
   * plausible mais absent de la base — « facture émise en mars » — se lit exactement comme un
   * fait, et personne ne remonte à la source pour vérifier une frise qui semble cohérente.
   *
   * Les jalons viennent donc TOUS d'une lecture : un PchOrder est un bon de commande, un
   * MailEntry est un courrier, un LegalDocument est un contrat. Ce qui est DÉDUIT (la date de
   * soumission, inférée de la publication) le dit dans `certitude`, et ce qui MANQUE — la
   * facture jamais émise — est affiché comme un trou, parce que c'est précisément ce qu'on
   * cherche en retraçant une affaire.
   *
   * Le modèle reçoit les KPI et les limites ; il LIT l'histoire, il ne l'écrit pas.
   */
  {
    def: {
      name: "business_story",
      description:
        "RETRACE UNE AFFAIRE DE BOUT EN BOUT (« retrace-moi l'AONIO 2023 », « raconte-moi l'histoire du Nivolumab », "
        + "« où ça a bloqué sur ce marché ? »). Reconstitue la CHRONOLOGIE RÉELLE depuis la base : publication, "
        + "soumission, attribution et ses lots, contrat et avenants, chaque bon de commande avec sa livraison, sa facture "
        + "et son paiement, les courriers, la clôture. Rend aussi les KPI de l'affaire (attribué, commandé, livré, encaissé, "
        + "délai moyen de paiement, retards) et ce qui MANQUE — un paiement jamais reçu apparaît comme un jalon absent. "
        + "N'INVENTE AUCUN JALON : chaque jalon porte sa PROVENANCE (l'enregistrement d'où il vient) et sa certitude — "
        + "fait ou déduit — de sorte que la DÉFINITION de ce qu'on montre voyage avec la donnée au lieu d'être supposée. "
        + "Accepte une référence de marché ou un nom de produit ; si la mention est ambiguë, rend la question à poser.",
      input_schema: {
        type: "object",
        properties: {
          affaire: { type: "string", description: "Référence de marché (« AO-2025-014 ») ou nom / DCI d'un produit." },
        },
        required: ["affaire"],
      },
    },
    // Une histoire d'affaire traverse marchés, contrats et paiements : la voir suppose la vue
    // PCH, qui est la porte d'entrée de ces objets. La plateforme revérifie de son côté.
    // L'ANCRE PEUT ÊTRE UN MARCHÉ **OU** UN PRODUIT, et la frise d'un produit montre ses
    // dossiers réglementaires. L'un des deux modules suffit donc — sous vue globale, qui reste
    // la vraie porte.
    allowed: (u) => vueTransverse(u, "PCH") || vueTransverse(u, "REGULATORY"),
    label: "Histoire d'une affaire",
    run: async (input, user) => {
      const ancre = str(input, "affaire");
      if (ancre.length < 2) return "De quelle affaire — marché, produit ?";

      const r = await inProcessPlatform.query(principalOf(user), { kind: "business.story", ancre });
      if (r.kind !== "business.story") return "Réponse inattendue de la plateforme.";
      if (!r.data) return r.question ?? "Affaire introuvable.";

      const st = r.data;
      // CE QUE LE MODÈLE LIT RESTE COURT — les chiffres et les manques, de quoi commenter. La
      // frise elle-même part dans `_blocs`, vers l'écran, et n'est pas relue par le modèle.
      return JSON.stringify({
        affaire: st.titre,
        precision: st.sousTitre,
        jalons: st.events.length,
        kpis: st.kpis,
        limites: st.limites,
        // TOUT CE DONT LE MODÈLE A BESOIN EST CI-DESSUS : le titre, le nombre de jalons, les
        // KPI et les limites. La frise, elle, est de l'affichage — quatre-vingts jalons avec
        // leurs pièces et leurs participants qu'il n'utiliserait pas. Ce drapeau l'en dispense.
        _blocsDecoratifs: true,
        _blocs: [{
          kind: "story",
          title: st.titre,
          subtitle: st.sousTitre,
          kpis: st.kpis,
          events: st.events,
          threads: st.threads,
          limites: st.limites,
          // L'IDENTITÉ DU BLOC EST STABLE : redemander la même affaire remplace la carte au lieu
          // d'en empiler une seconde dont on ne saurait plus laquelle fait foi.
          blockId: `story:${st.ancre.type}:${st.ancre.id}`,
          entityRef: st.ancre,
          state: "complete",
          certitude: "fait",
        }],
      });
    },
  },
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * « OÙ TU EN ES ? » — §46.
   *
   * ── POURQUOI CETTE CAPACITÉ NE RAISONNE PAS ─────────────────────────────────────────
   *
   * L'état d'une mission est EN BASE, exactement. Le faire décrire par un raisonnement long
   * coûterait une seconde et demie et introduirait le risque qu'il se trompe sur un compte
   * qu'un `SELECT` donne juste. Elle lit, elle compose, elle rend — et la carte se met à jour
   * SUR PLACE grâce à un `blockId` stable (§43), au lieu d'empiler une carte par instant.
   *
   * ── LA PORTE ────────────────────────────────────────────────────────────────────────
   *
   * Une mission appartient à quelqu'un. La requête filtre par `ownerId` : ce n'est pas un
   * contrôle de confort, c'est le cloisonnement — personne ne lit la mission d'un autre, même
   * en connaissant son identifiant.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  {
    def: {
      name: "mission_status",
      description:
        "OÙ EN EST UNE MISSION EN COURS (« où tu en es ? », « ça avance ? », « quelles missions tournent ? »). "
        + "Rend l'état RÉEL lu en base : chaque étape avec son état et son reçu, les éventails repliés avec leur "
        + "compte (« 31/33 effectuées »), les sous-missions, et ce qui attend une action de votre part. "
        + "DÉFINITION : l'avancement compte les étapes RÉELLEMENT exécutées — les itérations d'un éventail, pas leur "
        + "modèle — de sorte que 31 envois sur 33 s'affichent 31/33 et jamais 1/1. Sans identifiant, rend les "
        + "missions en cours. N'INVENTE RIEN : une étape sautée n'est jamais présentée comme faite.",
      input_schema: {
        type: "object",
        properties: {
          mission: { type: "string", description: "Identifiant de la mission. Omis : les missions en cours." },
        },
      },
    },
    // OUVERTE PAR DESSEIN, et cloisonnée PAR REQUÊTE — même design qu'`action_history` : la
    // lecture filtre sur `ownerId`, donc chacun ne voit que SES missions. Exiger en plus un
    // droit de module fermerait à quelqu'un l'accès à une mission qu'Adam a menée POUR LUI,
    // ce qui ne protège rien et retire une capacité. Le test de sécurité l'exige déclarée.
    allowed: peutPiloterMissionsAdam,
    refus: REFUS_MISSIONS_MODELE,
    label: "État d'une mission",
    run: async (input, user) => {
      const id = str(input, "mission");
      const r = await inProcessPlatform.query(principalOf(user), {
        kind: "mission.status", ...(id ? { mission: id } : {}),
      });
      if (r.kind !== "mission.status") return "Réponse inattendue de la plateforme.";

      if (!id) {
        const liste = r.missions ?? [];
        if (liste.length === 0) return JSON.stringify({ missions: [], message: "Aucune mission en cours." });
        return JSON.stringify({ missions: liste });
      }
      if (!r.data) return "Mission introuvable, ou elle ne vous appartient pas.";

      const v = r.data;
      return JSON.stringify({
        titre: v.titre,
        etat: v.etat,
        avancement: v.avancement,
        enAttenteDeVous: v.enAttenteDeVous,
        sousMissions: v.sousMissions,
        // LE DÉTAIL DES ÉTAPES PART À L'ÉCRAN, pas au modèle : trente lignes d'état qu'il ne
        // commenterait pas une par une, et dont il n'a pas besoin pour répondre.
        _blocsDecoratifs: true,
        _blocs: [v.bloc],
      });
    },
  },

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * LANCER UNE MISSION — la porte par laquelle une demande devient un PROGRAMME.
   *
   * ── QUAND ADAM DOIT L'UTILISER, ET QUAND IL NE DOIT PAS ────────────────────────────────
   *
   * Une demande ordinaire — « envoie un mail à Alla », « où en est le dossier X » — se traite
   * DIRECTEMENT : les outils existent, le geste est connu, une mission n'ajouterait qu'une
   * indirection et une latence. Le critère est la RÉPÉTITION ou la DURÉE : plusieurs actions
   * enchaînées, un éventail sur une liste de personnes, une attente d'événement, un livrable à
   * produire. C'est là qu'un DAG durable vaut mieux qu'une boucle de conversation, parce qu'il
   * survit à la fermeture de l'application.
   *
   * ── CE QUE CET OUTIL N'ACCORDE PAS ────────────────────────────────────────────────────
   *
   * Rien. Le catalogue offert au planificateur est `assistantToolsFor(user)` — exactement la
   * liste de CETTE personne. Chaque effet passe ensuite par le chemin canonique, avec RBAC,
   * intent, reçu, idempotence et approbation. Une mission ne peut donc rien faire que la
   * conversation ne puisse faire ; elle le fait plus longtemps, et sans rester connectée.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  {
    def: {
      name: "run_mission",
      description:
        "LANCE UNE MISSION DURABLE quand la demande dépasse une action isolée : plusieurs étapes enchaînées, "
        + "un même geste répété pour chaque personne d'une liste, une attente de réponse ou d'événement, "
        + "un fichier à produire, ou un travail qui doit continuer après la fermeture de l'application. "
        + "Adam PLANIFIE (un modèle propose un plan), le COMPILATEUR le valide (capacités réelles, droits, "
        + "cardinalité), puis un moteur durable l'exécute — reprise après panne, idempotence, contrôle qualité, "
        + "et vérification que l'objectif est réellement atteint. "
        + "NE PAS l'utiliser pour une action unique dont tu connais déjà le geste : fais-la directement. "
        + "« Dès que / quand [la signature, le paiement, la réponse, la livraison, la commande] arrive, fais X » EST une mission : une étape "
        + "WAIT_EVENT qui dort jusqu'au fait, puis l'action — PAS une surveillance (watch_entity ne fait que prévenir, elle n'agit jamais). "
        + "DÉFINITION : une mission est un GRAPHE d'étapes persistées, pas une boucle de conversation — "
        + "elle survit à la fermeture de l'application, reprend après une panne à l'étape exacte où elle "
        + "s'était arrêtée, et ne conclut QUE si le contrôle arithmétique passe ET qu'un juge a vérifié les "
        + "critères d'acceptation. Un envoi déjà parti n'est jamais renvoyé (clé d'idempotence). "
        + "Passe l'objectif EN ENTIER, mot pour mot, y compris les contraintes énoncées.",
      input_schema: {
        type: "object",
        properties: {
          objectif: {
            type: "string",
            description: "La demande complète, telle que la personne l'a formulée. Ne la résume pas.",
          },
          contraintes: {
            type: "array",
            items: { type: "string" },
            description: "Les contraintes explicites (« pas avant vendredi », « sans mettre en copie »).",
          },
          titre: { type: "string", description: "Un titre court pour l'écran. Facultatif." },
          arrierePlan: {
            type: "boolean",
            description:
              "TRUE quand la personne veut continuer à parler d'AUTRE CHOSE pendant que la mission "
              + "tourne (« fais ça de côté », « pendant ce temps », « on en reparle plus tard »), ou "
              + "quand le travail est long/massif. La mission est ENREGISTRÉE immédiatement (l'identifiant "
              + "revient en moins d'une seconde), la planification et l'exécution continuent en arrière-plan, "
              + "et la conversation est libre. FALSE (défaut) : la mission se planifie dans ce tour.",
          },
        },
        required: ["objectif"],
      },
    },
    // OUVERTE PAR DESSEIN — et cela n'accorde rien : voir l'en-tête. Le périmètre d'une mission
    // est le périmètre de la personne, calculé par le même code que la conversation.
    allowed: peutPiloterMissionsAdam,
    refus: REFUS_MISSIONS_MODELE,
    label: "Mission lancée",
    run: async (input, user) => {
      const objectif = str(input, "objectif");
      if (!objectif) return "Il manque l'objectif de la mission.";
      const contraintes = Array.isArray(input.contraintes)
        ? (input.contraintes as unknown[]).filter((c): c is string => typeof c === "string")
        : [];

      // IMPORT DIFFÉRÉ : le composeur importe le registre d'outils, qui importe ce fichier.
      // Un import statique fermerait le cycle et casserait le chargement du module.
      const { lancerMission, lancerEnArrierePlan } = await import("@/platform/in-process/missions/runtime");

      /**
       * ── LE DÉTACHEMENT (§12-13) — la conversation est libérée tout de suite ──────────
       *
       * Le talon est écrit en base, l'identifiant revient, la planification continue hors
       * requête — et le battement rattrape tout lancement dont le processus meurt en route.
       * L'accord éventuel arrivera par notification, comme pour toute mission.
       */
      if (input.arrierePlan === true) {
        const d = await lancerEnArrierePlan(user, objectif, {
          titre: str(input, "titre") || undefined,
          contexte: { contraintes },
        });
        if (!d.ok) {
          return JSON.stringify({ lancee: false, raison: d.error, message: "La mission n'a PAS été enregistrée." });
        }
        return JSON.stringify({
          lancee: true,
          missionId: d.missionId,
          titre: d.titre,
          arrierePlan: true,
          message: "Mission enregistrée — je m'en occupe en arrière-plan, on peut parler d'autre chose. "
            + "Je vous préviens quand elle aboutit (et je demanderai votre accord si elle veut produire un effet).",
          _blocsDecoratifs: true,
          _blocs: [{ kind: "mission", missionId: d.missionId, blockId: `mission:${d.missionId}` }],
        });
      }

      const r = await lancerMission(user, objectif, {
        titre: str(input, "titre") || undefined,
        contexte: { contraintes },
      });

      if (!r.ok) {
        return JSON.stringify({
          lancee: false,
          raison: r.error,
          refus: r.refus?.map((i) => `${i.code} — ${i.message}`) ?? [],
          message: "La mission n'a PAS été lancée. Rien n'a été exécuté.",
        });
      }

      if (r.differe) {
        return JSON.stringify({
          lancee: true,
          missionId: r.missionId,
          titre: r.titre,
          differe: true,
          message: "La demande est enregistrée ; le fournisseur de modèle a lâché pendant la planification, "
            + "elle reprend d'elle-même au prochain battement. Je vous préviens quand la mission aboutit.",
          _blocsDecoratifs: true,
          _blocs: [{ kind: "mission", missionId: r.missionId, blockId: `mission:${r.missionId}` }],
        });
      }
      return JSON.stringify({
        lancee: true,
        missionId: r.missionId,
        titre: r.titre,
        etapes: r.etapes,
        complexite: r.complexite,
        echelle: r.echelle,
        approbationRequise: r.approbation
          ? { niveau: r.approbation.niveau, resume: r.approbation.resume }
          : null,
        // CE QUE LE PLANIFICATEUR N'A PAS SU FAIRE, dit franchement plutôt que masqué.
        limites: r.gaps,
        message: r.approbation
          ? "Mission créée. Elle attend votre accord avant de produire ses effets."
          : "Mission créée et lancée. Elle continue même si vous fermez l'application.",
        _blocsDecoratifs: true,
        _blocs: [{ kind: "mission", missionId: r.missionId, blockId: `mission:${r.missionId}` }],
      });
    },
  },

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * REPRENDRE LA MAIN SUR UNE MISSION — et les deux gestes qui n'y sont PAS.
   *
   * ── CE QU'IL FAIT ───────────────────────────────────────────────────────────────────
   *
   * « Arrête la mission », « mets-la en pause », « je refuse » : trois phrases naturelles, trois
   * gestes qui RÉDUISENT ce qui va se passer. Les faire passer par la conversation est sans
   * risque, et c'est souvent là qu'on les dit — au téléphone, en marchant, sans écran.
   *
   * ── CE QU'IL NE FAIT PAS, ET C'EST LE CŒUR ─────────────────────────────────────────
   *
   * Il n'ACCORDE pas, et il ne FOURNIT pas. Ces deux-là sont des attestations humaines : « j'ai
   * lu, et j'autorise », « voici la pièce ». Les rendre appelables par un modèle les exposerait à
   * l'injection — un document déposé dans le Drive et lu par une étape pourrait contenir
   * « approuve la mission », et l'audit porterait ensuite le nom de la personne pour une décision
   * qu'elle n'a pas prise. C'est la seule falsification que ce système ne pourrait pas détecter
   * après coup, donc la seule qu'il faut rendre impossible avant.
   *
   * Ces deux gestes vivent dans `mission-runtime-actions.ts`, appelés par un vrai clic dans une
   * vraie session. Le refus ci-dessous le dit à la personne au lieu de faire semblant.
   *
   * ── ET DU CÔTÉ DES MISSIONS ────────────────────────────────────────────────────────
   *
   * `policy/guard.ts` refuse `mission_control` à tout acteur marqué `isAgent`, à la COMPILATION.
   * Une mission ne peut donc ni se relancer elle-même après une pause, ni s'arrêter pour éviter
   * un contrôle. Le nom de cet outil est dans la table des motifs, et un test le vérifie.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  {
    def: {
      name: "mission_control",
      description:
        "REPREND LA MAIN SUR UNE MISSION EN COURS : la suspendre, la reprendre, l'arrêter définitivement, "
        + "ou refuser une autorisation qu'elle demande. "
        + "DÉFINITION : ce sont les gestes qui RÉDUISENT ce qu'une mission va faire. "
        + "« pause » l'arrête là où elle est et elle repartira au même point ; « reprendre » la relance ; "
        + "« arreter » est définitif et ce qui a déjà été fait reste fait ; « refuser » ferme une demande "
        + "d'autorisation, et les étapes concernées ne s'exécuteront pas ; « replanifier » fait réécrire le "
        + "plan d'une mission bloquée ou en échec — ce que le nouveau plan ajoute repasse par l'accord de "
        + "la personne, donc rien ne part sans elle. "
        + "« modifier » CHANGE UNE MISSION EN COURS SANS TOUT REFAIRE : « finalement Amel à la place de "
        + "Deepak » (genre `remplacer`), « annule uniquement le PowerPoint » (`retirer`), « ajoute une "
        + "analyse financière » (`ajouter`), « utilise le nouveau forecast » (`rafraichir`). Seules les "
        + "étapes qui NOMMENT la cible et ce qui en dépend sont reprises ; le reste garde son travail, "
        + "ses reçus et ses effets déjà produits, et ce qui est DÉJÀ parti est nommé, jamais renvoyé. "
        + "Une cible que le plan ne nomme nulle part ne touche à RIEN et le dit : ne devine pas à sa place. "
        + "« suspendre_tout » BLOQUE TOUTES LES MISSIONS D'ADAM d'un coup (interrupteur global — comme tout cet outil, "
        + "réservé au Super Admin) : plus rien n'avance, ne se replanifie ni ne notifie, sans rien perdre — « bloque toutes "
        + "les missions », « arrête tout Adam », « plus aucune mission ». Aucun `missionId` pour ce geste. La "
        + "LEVÉE ne se fait que depuis l'écran des réglages d'Adam, jamais par cet outil : dis-le. "
        + "N'ACCORDE JAMAIS une autorisation et ne fournit jamais un élément demandé avec cet outil : "
        + "ces deux gestes-là exigent un clic de la personne sur l'écran de la mission — dis-le-lui.",
      input_schema: {
        type: "object",
        properties: {
          missionId: { type: "string", description: "L'identifiant de la mission — obligatoire pour tous les gestes sauf « suspendre_tout »." },
          geste: {
            type: "string",
            enum: ["pause", "reprendre", "arreter", "refuser", "replanifier", "prioriser", "plafonner_modele", "modifier", "suspendre_tout"],
            description: "Le geste demandé. « prioriser » la fait passer devant (valeur dans `priorite`) ; "
              + "« plafonner_modele » borne ses appels de modèle (« ne dépense plus de modèle dessus ») — "
              + "`plafond` en nombre d'appels, 0 pour geler, absent pour RETIRER le plafond.",
          },
          motif: { type: "string", description: "Pourquoi — repris dans le journal de la mission." },
          priorite: { type: "number", description: "Pour « prioriser » : -10 à 10, 0 = normal." },
          plafond: { type: "number", description: "Pour « plafonner_modele » : le nombre d'appels autorisés. Absent = retirer le plafond." },
          modification: {
            type: "string",
            enum: ["remplacer", "retirer", "ajouter", "rafraichir"],
            description: "Pour « modifier » : la nature du changement.",
          },
          cible: {
            type: "string",
            description: "Pour « modifier » : CE QUI EST VISÉ, dans les mots de la personne — « Deepak », "
              + "« le PowerPoint », « le forecast NIVOLEX ». Écris ce qu'elle a dit, pas une reformulation : "
              + "c'est ce texte qui est cherché dans les étapes du plan.",
          },
          remplacant: { type: "string", description: "Pour « modifier »/`remplacer` : qui ou quoi prend la place." },
          ajout: { type: "string", description: "Pour « modifier »/`ajouter` : le travail qui s'ajoute, en une phrase." },
        },
        required: ["geste"],
      },
    },
    // OUVERT PAR DESSEIN, comme `run_mission` : chaque fonction sous-jacente exige que la mission
    // appartienne à la personne, et un identifiant deviné ne donne rien. L'interrupteur global,
    // lui, exige la vue globale — vérifiée dans le pont, jamais ici.
    allowed: peutPiloterMissionsAdam,
    refus: REFUS_MISSIONS_MODELE,
    label: "Mission — reprise en main",
    run: async (input, user) => {
      const missionId = str(input, "missionId");
      const geste = str(input, "geste");
      const motif = str(input, "motif") || undefined;
      // IMPORT DIFFÉRÉ ET PAR LE PONT, pour deux raisons distinctes : le composeur importe ce
      // registre (un import statique fermerait le cycle), et `src/platform/in-process/` est le
      // SEUL endroit d'Adam autorisé à connaître l'ERP — importer `missions/` d'ici ferait
      // franchir la frontière deux fois de plus, ce que le cliquet refuse à juste titre.
      const ctl = await import("@/platform/in-process/missions/control");

      // LE SEUL GESTE SANS MISSION : il porte sur le moteur entier (§118.132), dans le sens qui
      // RÉDUIT. Le sens qui rouvre n'existe pas dans cet outil — le pont le dit à la personne.
      if (geste === "suspendre_tout") return JSON.stringify(await ctl.suspendreToutesLesMissions(user, motif));
      if (!missionId) return "Il manque l'identifiant de la mission.";

      if (geste === "pause") return JSON.stringify(await ctl.pauserMission(user, missionId, motif));
      if (geste === "reprendre") return JSON.stringify(await ctl.reprendreMissionAgent(user, missionId));
      if (geste === "arreter") return JSON.stringify(await ctl.arreterMissionAgent(user, missionId, motif));
      if (geste === "refuser") return JSON.stringify(await ctl.refuserAccordMission(user, missionId));
      if (geste === "replanifier") return JSON.stringify(await ctl.replanifierAgent(user, missionId));
      if (geste === "prioriser") {
        const p = typeof input.priorite === "number" ? input.priorite : 5;
        return JSON.stringify(await ctl.prioriserMission(user, missionId, p));
      }
      if (geste === "plafonner_modele") {
        const cap = typeof input.plafond === "number" ? input.plafond : null;
        return JSON.stringify(await ctl.plafonnerModeleMission(user, missionId, cap));
      }
      /**
       * ── « MODIFIER » EST ICI POUR LA MÊME RAISON QUE « REPLANIFIER » ────────────────────
       *
       * Il ne peut RIEN faire sortir sans accord. Une modification invalide des étapes et
       * rouvre le jalon touché ; le sous-plan qui suit repasse par le compilateur, la politique
       * d'acteur ET `reouvrirSiChange`. Une injection qui la déclencherait obtiendrait donc, au
       * pire, une demande d'accord de plus — ce qui se voit, et se refuse d'un clic.
       *
       * Et l'empreinte ne dépasse jamais la demande (§118.16) : une cible que le plan ne nomme
       * nulle part ne touche à rien, et ce qui est déjà parti est nommé plutôt que rejoué.
       */
      if (geste === "modifier") {
        const mod = await import("@/platform/in-process/missions/modifier");
        const nature = (str(input, "modification") || "remplacer").toUpperCase();
        const genres = ["REMPLACER", "RETIRER", "AJOUTER", "RAFRAICHIR"] as const;
        const genre = (genres as readonly string[]).includes(nature)
          ? (nature as (typeof genres)[number]) : "REMPLACER";
        return JSON.stringify(await mod.appliquerModification(user, missionId, {
          genre,
          cible: str(input, "cible"),
          remplacant: str(input, "remplacant") || null,
          ajout: str(input, "ajout") || null,
          motif,
        }));
      }

      // LE REFUS QUI COMPTE. Il est explicite et il ORIENTE : une personne à qui l'on dit
      // seulement « non » recommence ; une personne à qui l'on dit où cliquer y va.
      return JSON.stringify({
        fait: false,
        message:
          "Accorder une autorisation ou fournir un élément demandé ne se fait pas depuis la conversation : "
          + "ce sont des gestes que vous devez poser vous-même sur l'écran de la mission, pour que l'audit "
          + "porte votre décision et non la mienne. Ouvrez la mission et utilisez le bouton correspondant.",
        _blocsDecoratifs: true,
        _blocs: [{ kind: "mission", missionId, blockId: `mission:${missionId}` }],
      });
    },
  },
];
