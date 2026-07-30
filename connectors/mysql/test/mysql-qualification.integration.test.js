import assert from "node:assert/strict";
import test from "node:test";

import mysql from "mysql2/promise";

const qualificationUrl = process.env.MYSQL_QUALIFICATION_URL;
const integration = qualificationUrl === undefined ? test.skip : test;

integration("production-like connector identity uses TLS and least-privilege grants", async () => {
  const connection = await mysql.createConnection(qualificationUrl);
  try {
    const [sslRows] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    assert.equal(sslRows.length, 1);
    assert.notEqual(sslRows[0].Value, "", "MySQL session must negotiate TLS");

    const [grantRows] = await connection.query("SHOW GRANTS FOR CURRENT_USER");
    const grants = grantRows.flatMap((row) => Object.values(row)).join("\n").toUpperCase();
    assert.match(grants, /SELECT/u);
    assert.match(grants, /UPDATE/u);
    for (const forbidden of ["ALL PRIVILEGES", "GRANT OPTION", " INSERT", " DELETE", " CREATE", " DROP", " ALTER", " TRIGGER", " REFERENCES"]) {
      assert.equal(grants.includes(forbidden), false, `connector grants must not include ${forbidden.trim()}`);
    }
  } finally {
    await connection.end();
  }
});
