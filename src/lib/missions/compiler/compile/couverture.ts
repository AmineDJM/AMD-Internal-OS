/**
 * Compilateur de mission — LA COUVERTURE DE LA DEMANDE : la porte d'accord vide (convertie en
 * jonction), la question de confort au demandeur, les primitives exigées (§56) et autant de pièces
 * que la demande nomme de formats (§118.3).
 */
import { EFFECT_RANK } from "@/lib/missions/registry/capability-meta";
import { auMoinsUnePartira, direCondition, estInconditionnelle, nombreGaranti } from "@/lib/missions/compiler/garanties";
import type { CompiledStep, OptionsCompilation } from "./types";
import { issue, viseLeDemandeur } from "./outils";
import type { ContexteCompilation } from "./etape";

export function porteDAccordVide(ctx: ContexteCompilation): void {
  const { plan, warnings, compiled } = ctx;
  /**
   * ── LA PORTE D'ACCORD VIDE ──────────────────────────────────────────────────────────
   *
   * Banc m6, « aucune échéance réglementaire critique » : un nœud APPROVAL « validation du
   * dispositif de suivi » dans un plan sans aucune écriture sous accord. Le dirigeant a reçu un
   * ARBITRAGE — notification insistante, e-mail — pour un périmètre de « 0 étape à autoriser ».
   * Un accord porte sur des écritures (§8) ; sans écriture, la porte ne garde rien et coûte
   * l'attention la plus chère de la maison. Elle devient une jonction, et c'est dit.
   */
  if (!compiled.some((c) => c.needsApproval)) {
    for (const c of compiled) {
      if (c.nodeType !== "APPROVAL") continue;
      c.nodeType = "JOIN";
      warnings.push(issue("INVALID_SHAPE", c.key,
        `« ${c.title} » demandait un accord alors qu'aucune étape du plan n'est sous accord : la porte serait vide. `
        + `Convertie en jonction — un accord sans écriture coûte l'attention du dirigeant pour rien.`));
    }
  }
}

export function questionDeConfort(ctx: ContexteCompilation): void {
  const { actor, issues, compiled } = ctx;
  /**
   * ── LA QUESTION DE CONFORT AU DEMANDEUR ────────────────────────────────────────────
   *
   * Banc m5, mission « prépare la négociation » : quatre lectures, une note de position, puis
   * une attente humaine « validez-vous l'orientation ? » adressée au dirigeant — et RIEN n'en
   * dépendait. La mission dormait donc sur une question dont la réponse ne servait à personne,
   * alors que le livrable était prêt. « Mon attention est une ressource rare » : une question
   * dont la réponse n'alimente aucune étape n'est pas un arbitrage, c'est une validation de
   * confort. Refusée à la compilation, avec la règle de remplacement.
   */
  // LES CONSOMMATEURS d'une étape : ce qui en dépend, jonctions exclues — une JOIN ne lit rien,
  // et la compter permettrait de « consommer » une réponse en fermant simplement le graphe.
  const consommateurs = new Map<string, number>();
  for (const c of compiled) {
    if (c.nodeType === "JOIN") continue;
    for (const d of c.dependsOn) consommateurs.set(d, (consommateurs.get(d) ?? 0) + 1);
  }
  const typeParCle = new Map(compiled.map((c) => [c.key, c.nodeType]));
  const SYNTHESE_COMPILE: ReadonlySet<string> = new Set(["WORKER", "ARTIFACT", "QA"]);
  for (const c of compiled) {
    // La règle vise la question posée APRÈS UNE SYNTHÈSE (elle dépend d'un worker, d'un livrable
    // ou d'un contrôle : « au vu de la note, validez-vous ? ») et dont rien ne dépend. Une
    // attente humaine SANS amont (« attends que je te remette le contrat signé ») ou posée après
    // des ACTIONS (« j'ai écrit à tous ; quelle est la référence du marché ? ») n'est pas une
    // validation du travail : elle reste une attente — le demandeur a pu la demander telle quelle.
    if (c.nodeType !== "WAIT_INPUT" || (consommateurs.get(c.key) ?? 0) > 0) continue;
    if (!c.dependsOn.some((d) => SYNTHESE_COMPILE.has(typeParCle.get(d) ?? ""))) continue;
    const from = typeof c.waitFor?.from === "string" ? c.waitFor.from : "";
    if (!viseLeDemandeur(from, actor.label)) continue;
    issues.push(issue("INVALID_SHAPE", c.key,
      `« ${c.title} » pose au demandeur (${actor.label}), une fois le travail de synthèse fait, une `
      + `question dont la réponse n'alimente aucune étape. Ce n'est pas un arbitrage, c'est une validation `
      + `de confort : livre le résultat et conclus — le demandeur le lit. Si une décision conditionne `
      + `vraiment la suite, les étapes qui en dépendent doivent exister et dépendre de cette attente.`));
  }
}

/**
 * SOUS PLAFOND DE LECTURE, ON N'EXIGE NI PIÈCE NI ACTION.
 *
 * Une mission plafonnée à ANALYZE s'est vu dire « tu ne produis AUCUN fichier, tu n'écris
 * rien ». Lui reprocher ensuite de ne pas produire de document serait une contradiction, et
 * une contradiction qui BOUCLE : le refus repart au planificateur, qui ne peut pas y répondre.
 * Mesuré : « Lis ce document et fais-m'en un rapport » en lecture seule était refusé sans
 * issue. Le plafond retire l'exigence, il ne la déplace pas.
 */
export function produireEstInterdit(opts: OptionsCompilation): boolean {
  return opts.effetMax ? EFFECT_RANK[opts.effetMax] < EFFECT_RANK.PREPARE : false;
}

export function couverturePrimitives(ctx: ContexteCompilation, produireInterdit: boolean): void {
  const { plan, catalog, actor, opts, issues, compiled } = ctx;
  /**
   * ── 3 bis. LE PLAN COUVRE-T-IL CE QUE LA DEMANDE EXIGE ? (§56) ────────────────────────
   *
   * Jusqu'ici, les deux seuls contrôles « le plan fait quelque chose » étaient : au moins une
   * étape, et au moins un critère d'acceptation. Un plan « lire → répondre » compilait donc
   * parfaitement pour une demande qui réclamait un chiffre ou une pièce, et l'absence n'était
   * constatée qu'à la toute fin — par le contrôle arithmétique, après que toutes les étapes
   * avaient tourné et coûté. Pire : si le modèle avait omis `expectedArtifacts`, ce dernier
   * filet ne se déclenchait même pas et la mission concluait sans le livrable demandé.
   *
   * TROIS CONDITIONS avant de refuser, et chacune évite un refus à tort :
   *   1. la demande exige la primitive de façon SÛRE (les hésitations n'arrivent pas ici) ;
   *   2. le catalogue offre une capacité de cette primitive à CET acteur — sinon c'est un
   *      manque à déclarer, pas une faute de plan, et refuser boucherait la seule issue ;
   *   3. aucune étape du plan ne porte cette primitive.
   *
   * Le refus part au planificateur par `refusPrecedent` : c'est une correction, pas une mort.
   */
  /**
   * LE COMPILATEUR DIT TOUT CE QU'IL SAIT EN UNE FOIS.
   *
   * Cette vérification était gardée par `issues.length === 0` : elle ne parlait que d'un plan
   * par ailleurs valide. MESURÉ sur la chaîne humaine live : le premier plan est refusé pour la
   * forme de ses attentes, le planificateur corrige, et le SECOND plan découvre alors un
   * MISSING_PRIMITIVE dont le premier refus n'avait pas dit un mot. Deux essais, deux reproches
   * différents, mission morte — tuée par l'ORDRE dans lequel le compilateur formule ses
   * objections, pas par l'incompétence du modèle.
   *
   * Un compilateur qui distille ses reproches n'est pas plus prudent, il est plus cher : il fait
   * payer un aller-retour de planification par objection. On les dit toutes ensemble, et le
   * planificateur corrige tout en un tour.
   *
   * LA PRUDENCE RESTE, DÉPLACÉE AU BON ENDROIT : seules les capacités que le catalogue CONNAÎT
   * comptent comme couverture. Sinon une capacité inventée — déjà refusée par UNKNOWN_CAPABILITY
   * — apporterait sa primitive dérivée de son nom et masquerait le manque réel.
   */
  const requises = (opts.primitivesRequises ?? [])
    .filter((p) => !(produireInterdit && (p === "DOCUMENT" || p === "ACTION")));
  if (requises.length > 0) {
    const couvertes = new Set<string>();
    const porteuses = new Map<string, CompiledStep[]>();
    const porteusesDe = (p: string): CompiledStep[] => {
      const deja = porteuses.get(p);
      if (deja) return deja;
      const neuve: CompiledStep[] = [];
      porteuses.set(p, neuve);
      return neuve;
    };
    for (const e of compiled) {
      /**
       * UN NŒUD ARTIFACT PORTE LA PRIMITIVE DOCUMENT SANS PORTER DE CAPACITÉ.
       *
       * C'est LUI qui fabrique le fichier — le compilateur le sait déjà, puisqu'il lui applique
       * le plafond d'effet pour cette raison exacte. Ne compter que les capacités faisait donc
       * refuser des plans qui produisaient bel et bien le livrable demandé : quatre tests l'ont
       * dit immédiatement, et ils avaient raison.
       */
      if (e.nodeType === "ARTIFACT") { porteusesDe("DOCUMENT").push(e); continue; }
      if (!e.capability || !catalog.has(e.capability)) continue;
      const p = catalog.meta(e.capability).primitive;
      if (p) porteusesDe(p).push(e);
    }
    /**
     * ── UNE ÉTAPE CONDITIONNELLE PROPOSE ; ELLE NE PROMET PAS (§118.67) ──────────────────
     *
     * MESURÉ, mission `cmttakgtd…`, neuf versions de plan. Les DEUX étapes ARTIFACT étaient
     * conditionnées à la complétude des données amont ; une personne n'a pas tout donné, et
     * les deux sont sorties SKIPPED. Zéro fichier, zéro étape en échec, mission non bloquée,
     * journal muet. Le dirigeant a demandé un registre et n'a rien reçu — sans que rien ne le
     * dise. Le compilateur avait pourtant validé la couverture : il comptait le nœud ARTIFACT
     * comme portant DOCUMENT sans jamais regarder sa condition.
     *
     * La couverture d'une exigence FERME se compte donc sur ce que le plan GARANTIT. Deux
     * étapes conditionnelles comptent ENSEMBLE quand leurs conditions ne peuvent pas être
     * fausses en même temps — c'est la forme que la règle 18 IMPOSE pour une relance, et la
     * refuser serait un refus à tort (§118.27).
     */
    // SEUL WAIT_EVENT compte : c'est la seule attente qui puisse se régler par un FAIT ou par le
    // TEMPS, et le contrôle de forme ci-dessus refuse déjà EVENT / TIMEOUT derrière tout le reste.
    const attentes = new Set(compiled.filter((c) => c.nodeType === "WAIT_EVENT").map((c) => c.key));
    const estUneAttente = (cle: string) => attentes.has(cle);
    for (const [p, etapes] of porteuses) {
      if (auMoinsUnePartira(etapes.map((e) => ({ key: e.key, when: e.spec?.when ?? null })), estUneAttente)) couvertes.add(p);
    }
    const offertes = new Set<string>();
    for (const b of catalog.brief(actor, { limit: 1000 })) if (b.primitive) offertes.add(b.primitive);

    for (const p of requises) {
      if (couvertes.has(p) || !offertes.has(p)) continue;
      /**
       * ── LE REFUS NOMME LA FAUTE **ET** LE REMÈDE (§118.19, §118.30) ────────────────────
       *
       * « Aucune étape n'en porte » serait FAUX quand des étapes en portent mais sont toutes
       * conditionnelles — et un refus qu'on lit de travers est un refus qu'on croit moins
       * (§104.17). Le planificateur qui l'entend ajouterait une étape de plus, tout aussi
       * conditionnelle, et perdrait un aller-retour sur un reproche mal formulé.
       */
      const conditionnelles = porteuses.get(p) ?? [];
      if (conditionnelles.length > 0) {
        issues.push(issue("MISSING_PRIMITIVE", conditionnelles[0]?.key ?? null,
          `la demande exige la primitive ${p} sans condition, et les ${conditionnelles.length} étape(s) `
          + `du plan qui la portent sont TOUTES conditionnelles : `
          + `${conditionnelles.map((e) => `« ${e.key} » (${direCondition(e.spec?.when ?? null)})`).join(", ")}. `
          + `Si aucune de ces conditions n'est remplie, la mission ne produit RIEN et personne n'est `
          + `prévenu. Une étape au moins doit partir quoi qu'il arrive : retire la condition de celle `
          + `qui porte le résultat et fais-lui DIRE ce qui manque, plutôt que de ne rien rendre. Deux `
          + `étapes conditionnelles ne suffisent que si leurs conditions s'excluent — les deux issues `
          + `d'une même attente (EVENT / TIMEOUT), ou le même test en « eq » et en « ne ».`));
        continue;
      }
      issues.push(issue("MISSING_PRIMITIVE", null,
        `la demande exige la primitive ${p}, une capacité ${p} est disponible, et AUCUNE étape du `
        + `plan n'en porte. Ajoute l'étape qui manque — ou, si aucune capacité listée ne convient `
        + `réellement, dis-le dans « gaps » plutôt que de conclure sans.`));
    }
  }
}

export function nombreDePieces(ctx: ContexteCompilation, produireInterdit: boolean): void {
  const { plan, catalog, opts, issues, compiled } = ctx;
  /**
   * ── 3 ter. AUTANT DE PIÈCES QUE LA DEMANDE EN NOMME (§118.3, un cran plus haut) ────────
   *
   * MESURÉ sur la chaîne humaine live : « fais-moi un fichier Excel ET une présentation
   * PowerPoint » a produit UNE étape de livrable — le PowerPoint. Le classeur n'existait nulle
   * part, et la couverture (§56) n'avait rien à redire : elle demande qu'UNE étape porte la
   * primitive DOCUMENT, et une suffisait.
   *
   * C'est la « fausse cardinalité » de §118.3 appliquée aux pièces : deux fichiers demandés,
   * un fichier planifié. La mission a fini PARTIAL — honnêtement, le juge l'a vu — mais le
   * livrable manquant, lui, ne s'est pas fabriqué tout seul.
   *
   * La contrainte n'existe QUE quand la phrase nomme plusieurs formats DISTINCTS : c'est un
   * fait de la demande, pas une lecture. Silencieuse partout ailleurs.
   */
  const formats = opts.formatsLivrables ?? [];
  if (formats.length >= 2 && !produireInterdit) {
    const piecesDuPlan = compiled.filter((e) =>
      e.nodeType === "ARTIFACT"
      || (e.capability && catalog.has(e.capability) && catalog.meta(e.capability).primitive === "DOCUMENT"));
    /**
     * ── DEUX FAUTES DISTINCTES, DEUX CODES (§118.67) ───────────────────────────────────
     *
     * « Deux formats demandés, une étape écrite » est une CARDINALITÉ fausse : le plan est
     * faux, il ne peut pas livrer, et le refus est mortel.
     *
     * « Deux étapes écrites, une seule qui partira à coup sûr » est autre chose : le plan est
     * exécutable, il livre peut-être moins que ce que la demande nomme. C'est une exigence de
     * COUVERTURE (§118.29) — elle vaut un aller-retour de planification, jamais la mort d'une
     * mission. Confondre les deux ferait payer une pièce entière pour un « peut-être ».
     */
    const attentesLivrables = new Set(compiled.filter((c) => c.nodeType === "WAIT_EVENT").map((c) => c.key));
    const garanties = nombreGaranti(
      piecesDuPlan.map((e) => ({ key: e.key, when: e.spec?.when ?? null })),
      (cle) => attentesLivrables.has(cle));
    if (piecesDuPlan.length >= formats.length && garanties < formats.length) {
      const incertaines = piecesDuPlan.filter((e) => !estInconditionnelle({ key: e.key, when: e.spec?.when ?? null }));
      issues.push(issue("MISSING_PRIMITIVE", incertaines[0]?.key ?? null,
        `la demande nomme ${formats.length} livrables (${formats.join(", ")}) et le plan écrit bien `
        + `${piecesDuPlan.length} étape(s) qui produisent une pièce — mais ${garanties} seulement partira(ont) `
        + `à coup sûr : ${incertaines.map((e) => `« ${e.key} » (${direCondition(e.spec?.when ?? null)})`).join(", ")}. `
        + `Un livrable qu'on a demandé ne se conditionne pas à la qualité de ce qu'on a collecté : `
        + `produis-le avec ce que tu as et fais-lui DIRE ce qui manque.`));
    }
    const porteuses = piecesDuPlan;
    if (porteuses.length < formats.length) {
      /**
       * ── LE CODE DU REFUS EST « CARDINALITY », ET IL A COÛTÉ UN LIVRABLE DE L'APPRENDRE ──
       *
       * Cette règle a d'abord porté `MISSING_PRIMITIVE`, comme la couverture. Puis la tolérance
       * de §118.29 est arrivée — « une exigence de COUVERTURE ne tue pas une mission » — et elle
       * a laissé passer, au run suivant de la chaîne humaine, un plan qui ne produisait QUE le
       * PowerPoint. La personne avait demandé un classeur ET une présentation : le classeur n'a
       * jamais existé, et la mission a conclu PARTIAL.
       *
       * « Deux pièces demandées, une pièce planifiée » n'est pas une couverture incomplète :
       * c'est une CARDINALITÉ fausse, la même faute que « trente-trois destinataires dans un
       * seul envoi » (§118.3). Elle tue le plan, et c'est ce que dit son code.
       */
      issues.push(issue("CARDINALITY", null,
        `la demande nomme ${formats.length} livrables de formats différents (${formats.join(", ")}) `
        + `et le plan n'a que ${porteuses.length} étape(s) qui produisent une pièce. Une étape ne rend `
        + `qu'UN fichier : il en faut une par format demandé. Ajoute l'étape ARTIFACT manquante — ou, `
        + `si l'un de ces formats est hors de portée, dis-le dans « gaps » plutôt que de le laisser tomber.`));
    }
  }
}
