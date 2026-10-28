/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ADAPTATEUR WORD (§12) — « Centre le titre, réduis-le à 16, mets-le en Aptos. »
 *
 * ── CE QU'IL FAIT, ET CE QU'IL NE FAIT SURTOUT PAS ──────────────────────────────────────
 *
 * Il ouvre le ZIP, analyse `word/document.xml` en gardant chaque tranche de source
 * (`object-model/xml.ts`), construit un MODÈLE d'objets numérotés à l'humaine, applique des
 * commandes typées, et ré-écrit le ZIP en ne reconstruisant QUE les nœuds touchés.
 *
 * Il ne re-génère JAMAIS le document. C'est la différence entre « Adam modifie ton contrat » et
 * « Adam te rend un contrat qui ressemble au tien » : la seconde version perd les images, les
 * en-têtes, la numérotation automatique et les styles de la maison, et personne ne s'en aperçoit
 * avant que le client ne reçoive le fichier.
 *
 * ── LA NUMÉROTATION, QUI EST LE VRAI PIÈGE (§17) ────────────────────────────────────────
 *
 * « Supprime le troisième paragraphe » : le troisième que la PERSONNE voit. Un `.docx` compte
 * aussi les paragraphes des cellules de tableau, ceux des en-têtes, et les paragraphes vides
 * que Word insère après chaque tableau. Le modèle ne numérote QUE les paragraphes de corps —
 * `inTable` les distingue et ils sont exclus du rang — et `numbering.test.ts` le tient.
 *
 * Découpé par responsabilité en `adapter/` : `lecture` (le modèle numéroté, la pagination estimée),
 * `ecriture` (propriétés de paragraphe et de fragment, dans l'ordre du schéma) et `document` (le
 * document ouvert et l'adaptateur). Ce fichier n'est plus que la PORTE qui les réexporte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export { niveauDeTitre } from "./adapter/lecture";
export { MIME_DOCX, adaptateurDocx } from "./adapter/document";
