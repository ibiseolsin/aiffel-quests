"""receipt.total 의 계약. 이 파일은 바꾸지 않는다."""
import unittest

from receipt import subtotal, total

ITEMS = [{"price": 1000, "count": 2}, {"price": 500, "count": 3}]


class TestReceipt(unittest.TestCase):
    def test_subtotal(self):
        self.assertEqual(subtotal(ITEMS), 3500)

    def test_total_without_coupon(self):
        self.assertEqual(total(ITEMS), 3850)

    def test_coupon_applies_before_tax(self):
        # (3500 - 500) * 1.1 = 3300
        self.assertEqual(total(ITEMS, coupon=500), 3300)

    def test_rounds_to_nearest_won(self):
        # (3500 - 1) * 1.1 = 3848.9 -> 3849
        self.assertEqual(total(ITEMS, coupon=1), 3849)

    def test_never_negative(self):
        self.assertEqual(total(ITEMS, coupon=99999), 0)


if __name__ == "__main__":
    unittest.main()
