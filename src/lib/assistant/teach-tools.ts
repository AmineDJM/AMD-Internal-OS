/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TEACH ADAM — les outils par lesquels une personne ENSEIGNE une règle à Adam, la relit, la
 * corrige, la désactive, la supprime (§119).
 *
 * ── MÉMOIRE ≠ RÈGLE ─────────────────────────────────────────────────────────────────────
 *
 * `remember` retient des FAITS sur la personne et son vocabulaire (alias, sujets, contexte).
 * `teach_adam` enregistre COMMENT AGIR : une règle de société, un standard de document, un
 * seuil de validation, un workflow, une correspondance de termes, une définition, une
 * exception, une préférence de conduite. La règle a un périmètre (personnel / département /
 * société), un domaine, une priorité, une date d'effet, une version et une provenance ; Adam la
 * relit à chaque tour et le planificateur de missions la reçoit.
 *
 * ── CE QUE CE FICHIER NE FAIT PAS ───────────────────────────────────────────────────────
 *
 * Il n'écrit pas en base et ne décide d'aucun droit : tout passe par le pont
 * (`platform/in-process/teach/store.ts`), qui porte la porte des périmètres. Il n'importe
 * aucun module de l'ERP — la frontière Adam ↔ ERP est au plafond mesuré.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import { KINDS, SCOPES, DOMAINES_SUGGERES } from "@/platform/ia/teach/store";

const str = (input: Record<string, unknown>, k: string): string => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
const num = (input: Record<string, unknown>, k: string): number | null => (typeof input[k] === "number" && Number.isFinite(input[k] as number) ? (input[k] as number) : null);
const bool = (input: Record<string, unknown>, k: string): boolean => input[k] === true;
const obj = (input: Record<string, unknown>, k: string): Record<string, unknown> | null =>
  input[k] && typeof input[k] === "object" && !Array.isArray(input[k]) ? (input[k] as Record<string, unknown>) : null;

const vue = (r: { id: string; kind: string; kindLibelle: string; scope: string; scopeLibelle: string; societeNom: string | null; domain: string; title: string; statement: string; params: Record<string, unknown> | null; priority: number; version: number; status: string; statutLibelle: string; effectiveFrom: Date; effectiveTo: Date | null; supersedesId: string | null }) => ({
  id: r.id, nature: r.kind, natureLibelle: r.kindLibelle, perimetre: r.scope, perimetreLibelle: r.scopeLibelle, societe: r.societeNom,
  domaine: r.domain, titre: r.title, regle: r.statement, params: r.params, priorite: r.priority, version: r.version, statut: r.status, statutLibelle: r.statutLibelle,
  depuis: r.effectiveFrom.toISOString().slice(0, 10), jusquau: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null, remplace: r.supersedesId,
});

export const TEACH_TOOLS: PowerTool[] = [
  {
    def: {
      name: "teach_adam",
      description:
        "ENSEIGNE une RÈGLE durable à Adam — comment agir ou décider, pas un fait sur la personne (ça, c'est remember). "
        + "« Désormais les devis sont valables 45 jours », « toute facture au-dessus de 500 000 DZD passe par le PDG », "
        + "« quand je dis la DT, c'est la Direction technique », « d'abord le devis, puis le BC », « sauf pour les hôpitaux ». "
        + "Périmètre : PERSON (pour moi seul, défaut), GROUP (mon département), COMPANY (« pour toute la société », « seulement "
        + "pour Adventum » — Direction / Super Admin). Nature (kind) si tu la connais, sinon Adam classe et le dit. "
        + "Une règle de même clé déjà en vigueur est signalée comme CONFLIT : renvoyer alors `remplaceId` (nouvelle version) "
        + "ou `forcer` avec une `priorite`. Ne JAMAIS enseigner une règle de société sans que la personne l'ait demandé "
        + "explicitement pour la société. APPELLE cet outil même si une règle semblable figure dans l'historique de la "
        + "conversation : l'historique n'est pas la base, une règle a pu être supprimée depuis — sans appel, rien n'est enregistré. "
        + "SEULE EXCEPTION : la CHARTE GRAPHIQUE d'une société (couleur d'accent, polices, logo, mentions légales de pied, signataires "
        + "des devis / factures) se règle avec `document_profile` (geste definir, champ `marque`) — « règle la charte d'Adventum » "
        + "appelle document_profile. TOUT LE RESTE est une règle à enseigner ICI, même formulé pour toute la société : "
        + "« nos devis sont valables 45 jours », « paiement à 60 jours », « termine toujours par… » → teach_adam, jamais document_profile. "
        + "PAS UNE RÈGLE NON PLUS : « surveille X et préviens-moi s'il y a un problème » est une SURVEILLANCE (watch_entity) — une ligne "
        + "durable qui relit X ; l'enseigner comme règle ne surveillerait rien.",
      input_schema: {
        type: "object",
        properties: {
          statement: { type: "string", description: "La règle, en une ou deux phrases, telle que la personne l'a dite." },
          kind: { type: "string", enum: [...KINDS] },
          scope: { type: "string", enum: [...SCOPES], description: "PERSON par défaut." },
          societe: { type: "string", description: "COMPANY : nom, nom court ou identifiant de la société." },
          departement: { type: "string", description: "GROUP : nom, code ou identifiant du département. Vide = celui de la personne." },
          domaine: { type: "string", description: `Un domaine : ${DOMAINES_SUGGERES.join(", ")}. Vide = general.` },
          title: { type: "string", description: "Intitulé court. Vide = dérivé de la règle." },
          params: { type: "object", description: "Part structurée. Standard documentaire : { cle, valeur, unite } avec cle EXACTEMENT parmi validiteDevis (valeur en jours, nombre), prefixeFacture / prefixeDevis / prefixeBonDeCommande (valeur : le préfixe), tvaDefaut (fraction : 0.19), conditionsPaiement (texte), mentionPied (texte). Canaux (« préviens-moi par Slack », « pas de notification entre 22 h et 7 h ») : { cle: canalPrefere, valeur: notification | email | slack | teams | whatsapp | sms — « slack:#direction » pour nommer la destination } ; { cle: heuresSilence, valeur: { de: 22, a: 7 } }. Correspondance : { de, vers }. Validation : { seuil, devise }. Exception : { exceptionDe }. Vide = Adam extrait du texte." },
          priorite: { type: "integer", description: "-100 à 100 ; 0 par défaut. Départage deux règles de même périmètre." },
          effectiveFrom: { type: "string", description: "AAAA-MM-JJ. Vide = maintenant." },
          effectiveTo: { type: "string", description: "AAAA-MM-JJ. Vide = sans fin." },
          remplaceId: { type: "string", description: "L'identifiant de la règle que celle-ci remplace (nouvelle version)." },
          forcer: { type: "boolean", description: "Écrire malgré un conflit de même clé." },
          citation: { type: "string", description: "Les mots exacts de la personne, si différents de `statement`." },
        },
        required: ["statement"],
      },
    },
    allowed: () => true,
    label: "Teach Adam — règle enseignée",
    run: async (input, user) => {
      const { enseigner } = await import("@/platform/ia/teach/store");
      const r = await enseigner(user, {
        statement: str(input, "statement"), kind: str(input, "kind") || null, scope: str(input, "scope") || null,
        societe: str(input, "societe") || null, departement: str(input, "departement") || null, domaine: str(input, "domaine") || null,
        title: str(input, "title") || null, params: obj(input, "params"), priorite: num(input, "priorite"),
        effectiveFrom: str(input, "effectiveFrom") || null, effectiveTo: str(input, "effectiveTo") || null,
        remplaceId: str(input, "remplaceId") || null, forcer: bool(input, "forcer"), citation: str(input, "citation") || null,
      });
      if (!r.ok) return JSON.stringify({ fait: false, echec: r.echec, message: r.motif, conflits: r.conflits?.map(vue), candidats: r.candidats });
      const v = vue(r.regle);
      return JSON.stringify({
        fait: true, regle: v, classement: r.classement, remplacee: r.remplacee, avertissements: r.avertissements,
        message: `Règle ${v.id} enregistrée (${v.perimetreLibelle}${v.societe ? ` ${v.societe}` : ""} · ${v.natureLibelle} · v${v.version}) : « ${v.regle} ». Elle s'applique dès maintenant à chaque réponse et à chaque mission.${r.avertissements.length ? ` ${r.avertissements.join(" ")}` : ""}`,
      });
    },
  },
  {
    def: {
      name: "list_rules",
      description:
        "LISTE les règles enseignées à Adam qui concernent la personne : les siennes, celles de son département, celles de sa société. "
        + "« Quelles règles sur les factures ? » (texte ou domaine), « qu'est-ce que je t'ai appris ? », « quelles sont les règles "
        + "d'Adventum ? ». `id` + `historique` pour toutes les versions d'une règle. Chaque règle dit si elle est EN VIGUEUR "
        + "maintenant ou écartée par une autre, et pourquoi.",
      input_schema: {
        type: "object",
        properties: {
          texte: { type: "string", description: "Un mot ou une expression à chercher dans les règles." },
          domaine: { type: "string" },
          kind: { type: "string", enum: [...KINDS] },
          scope: { type: "string", enum: [...SCOPES] },
          societe: { type: "string" },
          historique: { type: "boolean", description: "Inclure les règles désactivées, remplacées et supprimées." },
          id: { type: "string", description: "Toutes les versions de cette règle." },
        },
      },
    },
    allowed: () => true,
    label: "Teach Adam — règles consultées",
    run: async (input, user) => {
      const { listerRegles } = await import("@/platform/ia/teach/store");
      const r = await listerRegles(user, {
        texte: str(input, "texte") || null, domaine: str(input, "domaine") || null, kind: str(input, "kind") || null, scope: str(input, "scope") || null,
        societe: str(input, "societe") || null, inclureHistorique: bool(input, "historique"), id: str(input, "id") || null,
      });
      if (!r.ok) return JSON.stringify({ fait: false, echec: r.echec, message: r.motif, candidats: r.candidats });
      if (r.total === 0) return JSON.stringify({ fait: true, total: 0, regles: [], message: "Aucune règle enseignée ne correspond. Pour en apprendre une : « Désormais… »." });
      return JSON.stringify({
        fait: true, total: r.total, enVigueur: r.enVigueur,
        regles: r.regles.map((x) => ({ ...vue(x), enVigueur: x.enVigueur, ecarteePar: x.ecarteePar })),
        message: `${r.total} règle(s), dont ${r.enVigueur} en vigueur pour vous maintenant.`,
      });
    },
  },
  {
    def: {
      name: "update_rule",
      description:
        "MODIFIE une règle enseignée (« finalement 60 jours », « monte la priorité », « jusqu'à fin décembre ») : une NOUVELLE "
        + "version est écrite, l'ancienne reste lisible dans l'historique. `id` vient de list_rules ou du contexte.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          statement: { type: "string" }, title: { type: "string" }, params: { type: "object" }, priorite: { type: "integer" },
          domaine: { type: "string" }, effectiveTo: { type: "string", description: "AAAA-MM-JJ ; chaîne vide = sans fin." },
          motif: { type: "string", description: "Pourquoi (gardé dans la provenance)." },
        },
        required: ["id"],
      },
    },
    allowed: () => true,
    label: "Teach Adam — règle modifiée",
    run: async (input, user) => {
      const { modifierRegle } = await import("@/platform/ia/teach/store");
      const r = await modifierRegle(user, {
        id: str(input, "id"), statement: str(input, "statement") || null, title: str(input, "title") || null, params: obj(input, "params"),
        priorite: num(input, "priorite"), domaine: str(input, "domaine") || null,
        effectiveTo: typeof input.effectiveTo === "string" ? input.effectiveTo : undefined, motif: str(input, "motif") || null,
      });
      if (!r.ok) return JSON.stringify({ fait: false, echec: r.echec, message: r.motif, conflits: r.conflits?.map(vue) });
      const v = vue(r.regle);
      return JSON.stringify({ fait: true, regle: v, remplacee: r.remplacee, message: `Règle ${r.remplacee} remplacée par ${v.id} (v${v.version}) : « ${v.regle} ».` });
    },
  },
  {
    def: {
      name: "disable_rule",
      description: "DÉSACTIVE une règle enseignée (« suspends cette règle », « ne l'applique plus pour l'instant ») ou la RÉACTIVE (`reactiver`). Rien n'est perdu.",
      input_schema: { type: "object", properties: { id: { type: "string" }, reactiver: { type: "boolean" }, motif: { type: "string" } }, required: ["id"] },
    },
    allowed: () => true,
    label: "Teach Adam — règle désactivée / réactivée",
    run: async (input, user) => {
      const { changerStatutRegle } = await import("@/platform/ia/teach/store");
      const reactiver = bool(input, "reactiver");
      const r = await changerStatutRegle(user, { id: str(input, "id"), statut: reactiver ? "ACTIVE" : "DISABLED", motif: str(input, "motif") || null });
      if (!r.ok) return JSON.stringify({ fait: false, echec: r.echec, message: r.motif });
      return JSON.stringify({ fait: true, regle: vue(r.regle), message: `Règle ${r.regle.id} ${reactiver ? "réactivée" : "désactivée"} : « ${r.regle.statement} ».` });
    },
  },
  {
    def: {
      name: "delete_rule",
      description: "SUPPRIME une règle enseignée (« supprime cette règle », « oublie cette règle »). Elle cesse de s'appliquer et sort des listes ; l'historique la garde (audit).",
      input_schema: { type: "object", properties: { id: { type: "string" }, motif: { type: "string" } }, required: ["id"] },
    },
    allowed: () => true,
    label: "Teach Adam — règle supprimée",
    run: async (input, user) => {
      const { changerStatutRegle } = await import("@/platform/ia/teach/store");
      const r = await changerStatutRegle(user, { id: str(input, "id"), statut: "DELETED", motif: str(input, "motif") || null });
      if (!r.ok) return JSON.stringify({ fait: false, echec: r.echec, message: r.motif });
      return JSON.stringify({ fait: true, regle: vue(r.regle), message: `Règle ${r.regle.id} supprimée : « ${r.regle.statement} » ne s'applique plus.` });
    },
  },
];
