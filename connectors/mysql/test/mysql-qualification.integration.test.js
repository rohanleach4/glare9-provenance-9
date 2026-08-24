import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import mysql from "mysql2/promise";

const qualificationUrl = process.env.MYSQL_QUALIFICATION_URL;
const qualificationCaPath = process.env.MYSQL_QUALIFICATION_CA_PATH;
const qualificationUntrustedCaPath = process.env.MYSQL_QUALIFICATION_UNTRUSTED_CA_PATH;
const qualificationDatabase = process.env.MYSQL_QUALIFICATION_DATABASE;
const qualificationTable = process.env.MYSQL_QUALIFICATION_TABLE ?? "provenance_outbox";
const qualificationOtherTable = process.env.MYSQL_QUALIFICATION_OTHER_TABLE;
const integration = qualificationUrl === undefined ? test.skip : test;

function safeIdentifier(value, name) {
  assert.match(value ?? "", /^[A-Za-z0-9_]+$/u, `${name} must be a safe MySQL identifier`);
  return `\`${value}\``;
}

async function expectAccessDenied(operation, action) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.code, "ER_TABLEACCESS_DENIED_ERROR", `${operation} must fail with table access denied`);
    return true;
  });
}

integration("connector identity uses verified TLS and exact-table least-privilege grants", async () => {
  assert.ok(qualificationCaPath, "MYSQL_QUALIFICATION_CA_PATH is required");
  assert.ok(qualificationUntrustedCaPath, "MYSQL_QUALIFICATION_UNTRUSTED_CA_PATH is required");
  const database = safeIdentifier(qualificationDatabase, "MYSQL_QUALIFICATION_DATABASE");
  const table = safeIdentifier(qualificationTable, "MYSQL_QUALIFICATION_TABLE");
  const otherTable = safeIdentifier(qualificationOtherTable, "MYSQL_QUALIFICATION_OTHER_TABLE");
  const ca = await readFile(qualificationCaPath, "utf8");
  const untrustedCa = await readFile(qualificationUntrustedCaPath, "utf8");
  const connection = await mysql.createConnection({
    uri: qualificationUrl,
    ssl: { ca, rejectUnauthorized: true },
  });
  try {
    const [sslRows] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    assert.equal(sslRows.length, 1);
    assert.notEqual(sslRows[0].Value, "", "MySQL session must negotiate TLS");
    const [tlsRows] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_version'");
    assert.equal(tlsRows.length, 1);
    assert.equal(tlsRows[0].Value, "TLSv1.3", "MySQL session must negotiate TLS 1.3");

    const [grantRows] = await connection.query("SHOW GRANTS FOR CURRENT_USER");
    const grants = grantRows.flatMap((row) => Object.values(row));
    const expectedTableGrant = `GRANT SELECT, UPDATE ON ${database}.${table} TO `;
    assert.equal(grants.filter((grant) => grant.startsWith(expectedTableGrant)).length, 1);
    for (const grant of grants) {
      assert.ok(
        grant.startsWith("GRANT USAGE ON *.* TO ") || grant.startsWith(expectedTableGrant),
        "connector identity must have only global USAGE and exact-table SELECT/UPDATE",
      );
    }

    await connection.query(`SELECT * FROM ${database}.${table} LIMIT 0`);
    await connection.query(`UPDATE ${database}.${table} SET sequence_id = sequence_id WHERE 1 = 0`);
    await expectAccessDenied("INSERT", () => connection.query(
      `INSERT INTO ${database}.${table} (event_id, envelope) VALUES ('qualification-denied', JSON_OBJECT())`,
    ));
    await expectAccessDenied("DELETE", () => connection.query(`DELETE FROM ${database}.${table} WHERE 1 = 0`));
    await expectAccessDenied("ALTER", () => connection.query(
      `ALTER TABLE ${database}.${table} ADD COLUMN qualification_denied INT NULL`,
    ));
    await expectAccessDenied("cross-table SELECT", () => connection.query(`SELECT * FROM ${database}.${otherTable} LIMIT 0`));
  } finally {
    await connection.end();
  }

  await assert.rejects(
    mysql.createConnection({ uri: qualificationUrl, ssl: false }),
    (error) => {
      assert.equal(error?.code, "ER_ACCESS_DENIED_ERROR");
      return true;
    },
    "connector identity must reject plaintext TCP",
  );
  await assert.rejects(
    mysql.createConnection({ uri: qualificationUrl, ssl: { ca: untrustedCa, rejectUnauthorized: true } }),
    /certificate|self-signed|unable to verify/u,
    "connector identity must reject an untrusted certificate authority",
  );
});
