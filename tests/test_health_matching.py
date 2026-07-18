import unittest

from scripts.enrich_health_inspections import (
    is_confident,
    normalize_address,
    normalize_name,
)


class HealthMatchingTest(unittest.TestCase):
    def test_location_suffixes_do_not_hide_a_brand_match(self) -> None:
        self.assertEqual(normalize_name("Gyu-Kaku - Times Square"), "gyu kaku")
        self.assertEqual(normalize_name("Anassa Taverna - Manhattan"), "anassa taverna")

    def test_address_abbreviations_are_normalized(self) -> None:
        self.assertEqual(
            normalize_address("145 East 39th Street"),
            normalize_address("145 E. 39 ST"),
        )

    def test_nearby_matching_name_is_confident(self) -> None:
        self.assertTrue(
            is_confident(
                {
                    "name": 0.91,
                    "address": 0.70,
                    "distanceMiles": 0.04,
                    "sameZip": True,
                    "phone": False,
                }
            )
        )

    def test_shared_address_does_not_match_an_unrelated_business(self) -> None:
        self.assertFalse(
            is_confident(
                {
                    "name": 0.27,
                    "address": 1.0,
                    "distanceMiles": 0.01,
                    "sameZip": True,
                    "phone": False,
                }
            )
        )

    def test_shared_phone_needs_location_or_name_evidence(self) -> None:
        self.assertFalse(
            is_confident(
                {
                    "name": 0.30,
                    "address": 0.35,
                    "distanceMiles": 1.4,
                    "sameZip": False,
                    "phone": True,
                }
            )
        )


if __name__ == "__main__":
    unittest.main()
