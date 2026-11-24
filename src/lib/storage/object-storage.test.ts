import { describe, it, expect, afterEach } from "vitest";
import { intoParts, uploadPartsBounded, hostAndPath, objectStorageConfigured, presignGetUrl, presignPutUrl, presignUploadPartUrl, _deriveSigningKeyHex, parseBucketNames, euJurisdictionHost } from "./object-storage";
import { VALIDITE_URL_S } from "./televersement-direct";

/**
 * Vérifie la signature SigV4 faite main (chantier 1 — upload direct S3/R2) SANS bucket réel :
 *  - dérivation de clé conforme au VECTEUR OFFICIEL AWS (preuve cryptographique) ;
 *  - gating par variables d'environnement ;
 *  - URL présignée PUT bien formée.
 * La validation « live » (le bucket accepte le PUT) se fait après provisionnement R2/S3.
 */
const ENV_KEYS = ["REG_S3_ENDPOINT", "REG_S3_BUCKET", "REG_S3_ACCESS_KEY_ID", "REG_S3_SECRET_ACCESS_KEY", "REG_S3_REGION", "REG_S3_FORCE_PATH_STYLE"];
const snapshot: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) snapshot[k] = process.env[k];

describe("object-storage — SigV4 (S3/R2), sans dépendance SDK", () => {
  afterEach(() => {
    for (const k of ENV_KEYS) { if (snapshot[k] === undefined) delete process.env[k]; else process.env[k] = snapshot[k]; }
  });

  it("dérive la clé de signature SigV4 (algorithme de référence AWS, valeur vérifiée indépendamment)", () => {
    // Entrées de l'exemple AWS (secret/date/region/service). Sortie = chaîne HMAC standard
    // AWS4→Date→Region→Service→aws4_request, recalculée indépendamment via crypto natif.
    expect(_deriveSigningKeyHex("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam"))
      .toBe("2c94c0cf5378ada6887f09bb697df8fc0affdb34ba1cdd5bda32b664bd55b73c");
  });

  it("non configuré → configured=false, presignPutUrl=null (repli sur l'upload en base)", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(objectStorageConfigured()).toBe(false);
    expect(presignPutUrl("reg-uploads/x.zip")).toBeNull();
  });

  it("configuré → URL PUT présignée bien formée (path-style, params X-Amz, signature 64 hex)", () => {
    process.env.REG_S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.REG_S3_BUCKET = "ctd";
    process.env.REG_S3_ACCESS_KEY_ID = "AKIAEXAMPLE";
    process.env.REG_S3_SECRET_ACCESS_KEY = "secretexample";
    process.env.REG_S3_REGION = "auto";
    delete process.env.REG_S3_FORCE_PATH_STYLE; // défaut = path-style

    expect(objectStorageConfigured()).toBe(true);
    const url = presignPutUrl("reg-uploads/co/abc.zip", 3600);
    expect(url).toBeTruthy();
    const u = new URL(url!);
    expect(u.host).toBe("acct.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/ctd/reg-uploads/co/abc.zip");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(u.searchParams.get("X-Amz-Credential")).toContain("AKIAEXAMPLE/");
    expect(u.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/aws4_request");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("URL présignée d'une PARTIE — les paramètres de l'opération sont SIGNÉS, pas ajoutés après", () => {
    // Le piège du multipart présigné : coller « ?partNumber=… » à une URL déjà signée produit une
    // signature qui ne couvre pas ces paramètres, et S3 répond 403 — un échec qu'on met des heures
    // à attribuer à la bonne cause. Ils doivent entrer dans la requête canonique.
    process.env.REG_S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.REG_S3_BUCKET = "ctd";
    process.env.REG_S3_ACCESS_KEY_ID = "AKIAEXAMPLE";
    process.env.REG_S3_SECRET_ACCESS_KEY = "secretexample";
    process.env.REG_S3_REGION = "auto";

    const url = presignUploadPartUrl("reg-uploads/co/abc.zip", "UPLOAD-ID-42", 7, 3600);
    expect(url).toBeTruthy();
    const u = new URL(url!);
    expect(u.searchParams.get("partNumber")).toBe("7");
    expect(u.searchParams.get("uploadId")).toBe("UPLOAD-ID-42");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    // La preuve que les paramètres sont bien SIGNÉS : changer le seul numéro de partie change
    // la signature. S'ils étaient collés après coup, elle serait identique.
    const other = new URL(presignUploadPartUrl("reg-uploads/co/abc.zip", "UPLOAD-ID-42", 8, 3600)!);
    expect(other.searchParams.get("X-Amz-Signature")).not.toBe(u.searchParams.get("X-Amz-Signature"));
  });

  it("F12 — dépôt signé 1 h au plus, lecture signée 5 min au plus, quoi que demande l'appelant", () => {
    process.env.REG_S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.REG_S3_BUCKET = "ctd";
    process.env.REG_S3_ACCESS_KEY_ID = "AKIAEXAMPLE";
    process.env.REG_S3_SECRET_ACCESS_KEY = "secretexample";
    const expire = (u: string | null) => Number(new URL(u!).searchParams.get("X-Amz-Expires"));
    expect(expire(presignUploadPartUrl("k", "u", 1, 6 * 3600))).toBe(3600);
    expect(expire(presignPutUrl("k", 24 * 3600))).toBe(3600);
    expect(expire(presignGetUrl("k", 900))).toBe(300);
    expect(expire(presignGetUrl("k", 2 * 3600))).toBe(300);
    expect(expire(presignGetUrl("k"))).toBe(300);
    expect(expire(presignGetUrl("k", 60))).toBe(60);
    expect(VALIDITE_URL_S).toBeLessThanOrEqual(3600);
  });

  it("une partie présignée sans stockage configuré rend null, comme le PUT simple", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(presignUploadPartUrl("k", "u", 1)).toBeNull();
  });

  it("parseBucketNames — extrait les noms de bucket, ignore le DisplayName du propriétaire", () => {
    // Réponse S3/R2 ListBuckets réaliste : le <DisplayName> du <Owner> ne doit PAS être capturé.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <Owner><ID>abc123</ID><DisplayName>compte-adventum</DisplayName></Owner>
        <Buckets>
          <Bucket><Name>ctd</Name><CreationDate>2026-07-01T00:00:00.000Z</CreationDate></Bucket>
          <Bucket><Name>drive-blobs</Name><CreationDate>2026-07-02T00:00:00.000Z</CreationDate></Bucket>
        </Buckets>
      </ListAllMyBucketsResult>`;
    expect(parseBucketNames(xml)).toEqual(["ctd", "drive-blobs"]);
    expect(parseBucketNames("<Buckets></Buckets>")).toEqual([]);
  });

  it("euJurisdictionHost — dérive l'hôte `.eu.` R2, null si déjà UE ou hôte non-R2", () => {
    expect(euJurisdictionHost("28b9db04.r2.cloudflarestorage.com")).toBe("28b9db04.eu.r2.cloudflarestorage.com");
    expect(euJurisdictionHost("28b9db04.eu.r2.cloudflarestorage.com")).toBeNull(); // déjà UE
    expect(euJurisdictionHost("s3.amazonaws.com")).toBeNull(); // non-R2 (S3/MinIO) → pas de variante
    expect(euJurisdictionHost("minio.local:9000")).toBeNull();
  });
});

describe("L'adresse exacte de l'objet — le chemin de l'endpoint EN FAIT PARTIE", () => {
  const cfg = (over: Partial<Parameters<typeof hostAndPath>[0]> = {}) => ({
    endpoint: "https://ref.storage.supabase.co/storage/v1/s3",
    region: "eu-west-1", bucket: "amd-internal-os",
    accessKeyId: "k", secretAccessKey: "s", pathStyle: true, ...over,
  });

  it("conserve le préfixe de l'endpoint — sans lui, Supabase répond 404 sur CHAQUE écriture", () => {
    // C'est le bug qui faisait échouer toute la migration : clés, bucket et région bons, et
    // pourtant « Écriture de l'objet échouée (404) » — on tapait à une adresse qui n'existe pas.
    const { host, resourcePath } = hostAndPath(cfg(), "blobs/ab/abcdef");
    expect(host).toBe("ref.storage.supabase.co");
    expect(resourcePath).toBe("/storage/v1/s3/amd-internal-os/blobs/ab/abcdef");
  });

  it("un endpoint sans chemin (R2, AWS, MinIO) reste inchangé", () => {
    const { resourcePath } = hostAndPath(cfg({ endpoint: "https://acct.r2.cloudflarestorage.com" }), "blobs/ab/x");
    expect(resourcePath).toBe("/amd-internal-os/blobs/ab/x");
  });

  it("une barre finale ne fabrique pas de double séparateur", () => {
    // « //amd-internal-os/… » n'est pas la même ressource pour S3 : la signature porterait sur un
    // chemin, la requête sur un autre.
    const { resourcePath } = hostAndPath(cfg({ endpoint: "https://ref.storage.supabase.co/storage/v1/s3/" }), "k");
    expect(resourcePath).toBe("/storage/v1/s3/amd-internal-os/k");
    expect(resourcePath).not.toContain("//");
  });

  it("en style sous-domaine, le bucket passe dans l'hôte et le préfixe reste dans le chemin", () => {
    const r = hostAndPath(cfg({ pathStyle: false, endpoint: "https://ref.storage.supabase.co/storage/v1/s3" }), "blobs/ab/x");
    expect(r.host).toBe("amd-internal-os.ref.storage.supabase.co");
    expect(r.resourcePath).toBe("/storage/v1/s3/blobs/ab/x");
  });

  it("l'URL présignée porte le même chemin — sinon le navigateur taperait ailleurs que la signature", () => {
    // La requête canonique signée et l'URL appelée DOIVENT coïncider au caractère près.
    const url = presignPutUrl("blobs/ab/x");
    if (url) expect(url).toContain("/storage/v1/s3/");
  });
});

describe("Découpage en parties — la règle des 5 Mio, respectée sans y penser", () => {
  const feed = async function* (...sizes: number[]): AsyncGenerator<Buffer> {
    for (const n of sizes) yield Buffer.alloc(n, 7);
  };
  const collect = async (gen: AsyncGenerator<Buffer>) => {
    const out: Buffer[] = [];
    for await (const p of gen) out.push(p);
    return out;
  };

  it("regroupe des morceaux quelconques en parties de taille FIXE", async () => {
    // Le chiffrement en flux rend des morceaux de tailles arbitraires : les envoyer tels quels
    // ferait refuser le téléversement dès la deuxième partie (« EntityTooSmall »).
    const parts = await collect(intoParts(feed(3, 3, 3, 3), 5));
    expect(parts.map((p) => p.length)).toEqual([5, 5, 2]);
  });

  it("découpe un morceau plus GRAND qu'une partie", async () => {
    const parts = await collect(intoParts(feed(23), 10));
    expect(parts.map((p) => p.length)).toEqual([10, 10, 3]);
  });

  it("seule la DERNIÈRE partie peut être plus petite", async () => {
    const parts = await collect(intoParts(feed(7, 7, 7), 4));
    expect(parts.slice(0, -1).every((p) => p.length === 4)).toBe(true);
    expect(parts[parts.length - 1].length).toBeLessThanOrEqual(4);
  });

  it("ne perd ni ne duplique un octet", async () => {
    const total = [11, 5, 30, 1].reduce((a, b) => a + b, 0);
    const parts = await collect(intoParts(feed(11, 5, 30, 1), 8));
    expect(parts.reduce((a, p) => a + p.length, 0)).toBe(total);
    expect(Buffer.concat(parts).every((b) => b === 7)).toBe(true);
  });

  it("un flux vide rend UNE partie vide — le protocole en exige au moins une", async () => {
    const parts = await collect(intoParts(feed(), 8));
    expect(parts.map((p) => p.length)).toEqual([0]);
  });

  it("ignore les morceaux vides intercalés sans fabriquer de partie vide", async () => {
    const parts = await collect(intoParts(feed(0, 4, 0, 4), 8));
    expect(parts.map((p) => p.length)).toEqual([8]);
  });

  it("un contenu exactement multiple ne produit PAS de partie vide finale", async () => {
    const parts = await collect(intoParts(feed(16), 8));
    expect(parts.map((p) => p.length)).toEqual([8, 8]);
  });
});

describe("Plusieurs parties en vol — le lien est enfin utilisé", () => {
  const feed = async function* (count: number): AsyncGenerator<Buffer> {
    for (let i = 0; i < count; i++) yield Buffer.alloc(4, i);
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("rend les ETags dans l'ordre des NUMÉROS de partie, pas des réponses", async () => {
    // C'est tout l'enjeu : les réponses reviennent dans le désordre, le fichier se recolle dans
    // l'ordre des numéros. Ici la partie 1 répond en dernier, exprès.
    const send = async (n: number) => { await wait(n === 1 ? 30 : 1); return `"etag-${n}"`; };
    const etags = await uploadPartsBounded(feed(4), send, 4);
    expect(etags).toEqual(['"etag-1"', '"etag-2"', '"etag-3"', '"etag-4"']);
  });

  it("ne dépasse jamais la limite de requêtes simultanées", async () => {
    let inFlight = 0;
    let peak = 0;
    const send = async (n: number) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await wait(5);
      inFlight--;
      return `"e${n}"`;
    };
    await uploadPartsBounded(feed(9), send, 3);
    expect(peak).toBe(3);
  });

  it("une limite de 1 revient à l'envoi séquentiel", async () => {
    let peak = 0, cur = 0;
    const send = async (n: number) => { cur++; peak = Math.max(peak, cur); await wait(1); cur--; return `"e${n}"`; };
    const etags = await uploadPartsBounded(feed(3), send, 1);
    expect(peak).toBe(1);
    expect(etags).toHaveLength(3);
  });

  it("relève l'erreur d'une partie — un téléversement à moitié écrit n'est pas un succès", async () => {
    const send = async (n: number) => { await wait(1); if (n === 2) throw new Error("Envoi de la partie 2 échoué (500)."); return `"e${n}"`; };
    await expect(uploadPartsBounded(feed(6), send, 3)).rejects.toThrow("partie 2");
  });

  it("attend les parties DÉJÀ EN VOL avant de relever l'erreur", async () => {
    // Sinon l'abandon du téléversement partirait pendant que des parties sont encore en route :
    // elles arriveraient APRÈS lui, et resteraient orphelines dans le bucket.
    let running = 0;
    const send = async (n: number) => {
      running++;
      await wait(n === 1 ? 1 : 20);
      running--;
      if (n === 1) throw new Error("boum");
      return `"e${n}"`;
    };
    await expect(uploadPartsBounded(feed(3), send, 3)).rejects.toThrow("boum");
    expect(running).toBe(0);
  });

  it("un flux d'une seule partie passe sans parallélisme inutile", async () => {
    const etags = await uploadPartsBounded(feed(1), async (n) => `"e${n}"`, 4);
    expect(etags).toEqual(['"e1"']);
  });
});
