"""greet 의 계약. 이 파일은 바꾸지 않는다."""
import unittest

from greeting import greet


class TestGreeting(unittest.TestCase):
    def test_named(self):
        self.assertEqual(greet("지훈"), "안녕하세요, 지훈님!")

    def test_empty(self):
        self.assertEqual(greet(""), "안녕하세요!")


if __name__ == "__main__":
    unittest.main()
