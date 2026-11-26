import unittest
from pathlib import Path

from check_contract_error_docs import check, compare, parse_enum, parse_rows, section

REPO_ROOT = Path(__file__).resolve().parent.parent


class ContractErrorDocsTests(unittest.TestCase):
    def test_repository_table_matches_the_enums(self):
        self.assertEqual(check(REPO_ROOT), [])

    def test_parse_enum_ignores_doc_comments(self):
        source = """
#[contracterror]
pub enum Error {
    /// Triggered when input is invalid = 99,
    InvalidInput = 1,
    // NotAVariant = 7,
    NotFound = 3,
}
"""
        self.assertEqual(parse_enum(source), {"InvalidInput": 1, "NotFound": 3})

    def test_compare_reports_missing_renumbered_and_stale_rows(self):
        variants = {"InvalidInput": 1, "NotFound": 3, "Unauthorized": 8}
        rows = {"InvalidInput": 1, "NotFound": 4, "Removed": 9}
        problems = compare(variants, rows, "core")
        self.assertIn("core: `Unauthorized` (code 8) is missing from the table", problems)
        self.assertIn("core: `NotFound` is documented as 4 but is 3 in the source", problems)
        self.assertIn("core: table row `Removed` (code 9) does not exist in the source", problems)

    def test_rows_are_scoped_to_their_section(self):
        doc = "## A\n| `1` | `Foo` | x | y |\n## B\n| `1` | `Bar` | x | y |\n"
        self.assertEqual(parse_rows(section(doc, "## A")), {"Foo": 1})
        self.assertEqual(parse_rows(section(doc, "## B")), {"Bar": 1})


if __name__ == "__main__":
    unittest.main()
