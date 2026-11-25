import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Points d'appel (§118.49) : les écrans lisent la table UNIQUE des aperçus, ils n'ont plus leur propre liste. */
const lire = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("l'aperçu universel — une table, tous les écrans", () => {
  it("la fenêtre des documents et la visionneuse du Drive montent le MÊME composant, sur leur cible", () => {
    expect(lire("src/components/documents/document-preview.tsx")).toMatch(/<ApercuUniversel[^>]*cible=\{srcOverride \? undefined : \{ type: "document", id \}\}/);
    expect(lire("src/app/(app)/drive/[id]/file-viewer.tsx")).toMatch(/<ApercuUniversel[^>]*cible=\{\{ type: "drive", id \}\}/);
  });

  it("plus aucune liste d'extensions locale dans ces écrans", () => {
    expect(lire("src/components/documents/document-preview.tsx")).not.toMatch(/const (IMAGE|TEXTLIKE) = \[/);
    expect(lire("src/components/documents/document-preview.tsx")).not.toContain("kindFromName");
    expect(lire("src/components/documents/zip-viewer.tsx")).not.toMatch(/\["png", "jpg"/);
  });

  it("Word, Excel, PowerPoint et leurs anciens formats s'ouvrent DANS L'ÉDITEUR OFFICE — la visionneuse du navigateur n'est que le secours", () => {
    const src = lire("src/components/documents/apercu-universel.tsx");
    expect(src).toContain("<EditeurEnLigne");
    for (const v of ["DocxView", "XlsxView", "PptxView"]) expect(src, v).toContain(`<${v} `);
    // Plus de conversion en PDF : on ouvre le document tel qu'il est.
    expect(src).not.toMatch(/apercuSrc|\/apercu`|VueConvertie/);
    expect(existsSync(join(process.cwd(), "src/lib/apercu-pdf.ts"))).toBe(false);
  });

  it("les droits de l'éditeur se jugent côté serveur, avant toute configuration", () => {
    const route = lire("src/app/api/onlyoffice/session/route.ts");
    expect(route).toContain("getCurrentUser()");
    expect(route.indexOf("getCurrentUser()")).toBeLessThan(route.indexOf("sessionEditeur("));
    const lib = lire("src/lib/onlyoffice-session.ts");
    expect(lib).toMatch(/canViewDrive\(acces\)/);
    expect(lib).toContain('canAccessEntity(user, doc.entityType, doc.entityId, "VIEW")');
    expect(lib).toContain('canAccessEntity(user, doc.entityType, doc.entityId, "UPLOAD")');
    // Lecture seule tant que le droit de modifier ou le format réécrivable manque.
    expect(lib).toContain('peutModifier && modifiable ? "edit" : "view"');
  });

  it("le texte se lit (GET) et s'enregistre (POST) sur le serveur : routes gardées, conflit détecté", () => {
    for (const kind of ["documents", "drive"]) {
      const lecture = lire(`src/app/api/${kind}/[id]/texte/route.ts`);
      expect(lecture, kind).toContain("export async function GET");
      expect(lecture, kind).not.toContain("getCurrentUserPourEcrire");
      const ecriture = lire(`src/app/api/${kind}/[id]/texte/enregistrer/route.ts`);
      expect(ecriture, kind).toContain("export async function POST");
      expect(ecriture, kind).toContain("getCurrentUserPourEcrire()");
      expect(ecriture, kind).toContain("status: 409");
      expect(ecriture, kind).not.toContain("getCurrentUser()");
    }
  });

  // Direction, 06/10 : « pas que Drive ou Regulatory, et avec les exactes et mêmes performances ».
  it("fichiers, ZIP et dossiers envoyés en messagerie passent par le MOTEUR du Drive — plus d'archive en mémoire", () => {
    const composer = lire("src/app/(app)/messages/composer.tsx");
    expect(composer).not.toContain("jszip");
    expect(composer).not.toContain("/api/messaging/upload-dossier");
    expect(composer).not.toContain(".slice(0, 10)"); // plus de troncature silencieuse à dix fichiers
    expect(composer).toContain("preparerDepotMessagerie(");
    expect(composer).toContain("enqueue(envoiArborescenceDrive(");
    expect(composer).toContain("lireDepot("); // glisser-déposer, dossiers compris
    // UNE construction pour l'import de dossier du Drive et la messagerie : mêmes performances par construction.
    // Audit Drive (C1-C16) : le bouton délègue au chemin de dépôt UNIQUE du Drive (`depot-drive.tsx`).
    expect(lire("src/app/(app)/drive/upload-button.tsx")).toContain("./depot-drive");
    expect(lire("src/app/(app)/drive/depot-drive.tsx")).toContain("enqueue(envoiArborescenceDrive(");
    const actions = lire("src/lib/actions/messaging-actions.ts");
    expect(actions).toContain('userCan(user, "MESSAGING", "UPLOAD")');
    expect(actions).toContain("canAccessConversation(user.id, conversationId)");
    expect(actions).toContain("ownerId: user.id, isTrashed: false"); // un lot n'est joint que par son propriétaire
  });

  it("l'HTML d'un tiers ne s'exécute jamais dans l'application (cadre isolé)", () => {
    expect(lire("src/components/documents/apercu-universel.tsx")).toContain('sandbox=""');
  });

  it("le lien de téléchargement d'une entrée de ZIP vise la route de l'archive, pas le nom du fichier", () => {
    const zip = lire("src/components/documents/zip-viewer.tsx");
    expect(zip).not.toContain("title={base}");
    expect(zip).toContain("const nom = e.path.split");
  });
});
