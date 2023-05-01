import { SourceBase, StorageBase, Tree, TreeFile } from "../types";
import { S3 } from "aws-sdk";
import config from "../../config";
import { pipeline, Readable, Transform } from "stream";
import ArchiveStreamToS3 from "decompress-stream-to-s3";
import { Response } from "express";
import { lookup } from "mime-types";
import * as flow from "xml-flow";
import * as archiver from "archiver";
import { dirname, basename } from "path";
import AnonymousError from "../AnonymousError";
import AnonymizedFile from "../AnonymizedFile";

export default class S3Storage implements StorageBase {
  type = "AWS";

  constructor() {
    if (!config.S3_BUCKET)
      throw new AnonymousError("s3_config_not_provided", {
        httpStatus: 500,
      });
  }

  private client(timeout = 5000) {
    return new S3({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      accessKeyId: config.S3_CLIENT_ID,
      secretAccessKey: config.S3_CLIENT_SECRET,
      httpOptions: {
        timeout,
      },
    });
  }

  /** @override */
  async exists(path: string): Promise<boolean> {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    try {
      await this.client()
        .headObject({
          Bucket: config.S3_BUCKET,
          Key: path,
        })
        .promise();
      return true;
    } catch (err) {
      // check if it is a directory
      const data = await this.client()
        .listObjectsV2({
          Bucket: config.S3_BUCKET,
          Prefix: path,
          MaxKeys: 1,
        })
        .promise();
      return (data.Contents?.length || 0) > 0;
    }
  }

  /** @override */
  async mk(dir: string): Promise<void> {
    // no need to create folder on S3
  }

  /** @override */
  async rm(dir: string): Promise<void> {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    const data = await this.client()
      .listObjectsV2({
        Bucket: config.S3_BUCKET,
        Prefix: dir,
        MaxKeys: 1000,
      })
      .promise();

    const params = {
      Bucket: config.S3_BUCKET,
      Delete: { Objects: new Array<{ Key: string }>() },
    };

    data.Contents?.forEach(function (content) {
      if (content.Key) {
        params.Delete.Objects.push({ Key: content.Key });
      }
    });

    if (params.Delete.Objects.length == 0) {
      // nothing to remove
      return;
    }
    await this.client().deleteObjects(params).promise();

    if (data.IsTruncated) {
      await this.rm(dir);
    }
  }

  /** @override */
  send(p: string, res: Response) {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    const s = this.client()
      .getObject({
        Bucket: config.S3_BUCKET,
        Key: p,
      })
      .on("error", (error) => {
        try {
          res.status(error.statusCode || 500);
        } catch (err) {
          console.error(`[ERROR] S3 send ${p}`, err);
        }
      })
      .on("httpHeaders", (statusCode, headers, response) => {
        res.status(statusCode);
        if (statusCode < 300) {
          res.set("Content-Length", headers["content-length"]);
          res.set("Content-Type", headers["content-type"]);
        }
        (response.httpResponse.createUnbufferedStream() as Readable).pipe(res);
      });

    s.send();
  }

  async fileInfo(path: string) {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    const info = await this.client(3000)
      .headObject({
        Bucket: config.S3_BUCKET,
        Key: path,
      })
      .promise();
    return {
      size: info.ContentLength,
      lastModified: info.LastModified,
      contentType: info.ContentType
        ? info.ContentType
        : (lookup(path) as string),
    };
  }

  /** @override */
  read(path: string): Readable {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    return this.client(3000)
      .getObject({
        Bucket: config.S3_BUCKET,
        Key: path,
      })
      .createReadStream();
  }

  /** @override */
  async write(
    path: string,
    data: Buffer,
    file?: AnonymizedFile,
    source?: SourceBase
  ): Promise<void> {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    const params: S3.PutObjectRequest = {
      Bucket: config.S3_BUCKET,
      Key: path,
      Body: data,
      ContentType: lookup(path).toString(),
    };
    if (source) {
      params.Tagging = `source=${source.type}`;
    }
    // 30s timeout
    await this.client(30000).putObject(params).promise();
    return;
  }

  /** @override */
  async listFiles(dir: string): Promise<Tree> {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    if (dir && dir[dir.length - 1] != "/") dir = dir + "/";
    const out: Tree = {};
    let req: S3.ListObjectsV2Output;
    let nextContinuationToken: string | undefined;
    do {
      req = await this.client(30000)
        .listObjectsV2({
          Bucket: config.S3_BUCKET,
          Prefix: dir,
          MaxKeys: 250,
          ContinuationToken: nextContinuationToken,
        })
        .promise();
      if (!req.Contents) return out;
      nextContinuationToken = req.NextContinuationToken;

      for (const f of req.Contents) {
        if (!f.Key) continue;
        f.Key = f.Key.replace(dir, "");
        const paths = f.Key.split("/");
        let current: Tree = out;
        for (let i = 0; i < paths.length - 1; i++) {
          let p = paths[i];
          if (!p) continue;
          if (!(current[p] as Tree)) {
            current[p] = {} as Tree;
          }
          current = current[p] as Tree;
        }

        if (f.ETag) {
          const fileInfo: TreeFile = { size: f.Size || 0, sha: f.ETag };
          const fileName = paths[paths.length - 1];
          if (fileName) current[fileName] = fileInfo;
        }
      }
    } while (req && req.Contents && req.IsTruncated);
    return out;
  }

  /** @override */
  async extractZip(
    p: string,
    data: Readable,
    file?: AnonymizedFile,
    source?: SourceBase
  ): Promise<void> {
    let toS3: ArchiveStreamToS3;

    return new Promise((resolve, reject) => {
      if (!config.S3_BUCKET) return reject("S3_BUCKET not set");
      toS3 = new ArchiveStreamToS3({
        bucket: config.S3_BUCKET,
        prefix: p,
        s3: this.client(2 * 60 * 60 * 1000), // 2h timeout
        type: "zip",
        onEntry: (header) => {
          header.name = header.name.substr(header.name.indexOf("/") + 1);
          if (source) {
            header.Tagging = `source=${source.type}`;
          }
        },
      });
      pipeline(data, toS3, () => {})
        .on("finish", resolve)
        .on("error", reject);
    });
  }

  /** @override */
  archive(
    dir: string,
    opt?: {
      format?: "zip" | "tar";
      fileTransformer?: (p: string) => Transform;
    }
  ) {
    if (!config.S3_BUCKET) throw new Error("S3_BUCKET not set");
    const archive = archiver(opt?.format || "zip", {});
    if (dir && dir[dir.length - 1] != "/") dir = dir + "/";
    const req = this.client(30000).listObjectsV2({
      Bucket: config.S3_BUCKET,
      Prefix: dir,
    });
    const filesStream = req.createReadStream();

    const xmlStream = flow(filesStream);

    const that = this;
    xmlStream.on("tag:contents", function (file) {
      let rs = that.read(file.key);
      file.key = file.key.replace(dir, "");
      const filename = basename(file.key);
      if (filename == "") return;
      if (opt?.fileTransformer) {
        rs = rs.pipe(opt.fileTransformer(filename));
      }
      archive.append(rs, {
        name: filename,
        prefix: dirname(file.key),
      });
    });
    xmlStream.on("end", () => {
      archive.finalize();
    });
    return archive;
  }
}
