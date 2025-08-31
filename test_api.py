import requests

BASE_URL = "http://127.0.0.1:8000"

def test_cases():
    cases = [
        # ✅ Simple factual
        {"question": "What is the capital of Mongolia?"},
        
        # ✅ Complex reasoning
        {"question": "If a train leaves Paris at 9 AM at 80 km/h and another leaves Lyon at 10 AM at 100 km/h towards Paris (450 km away), when will they meet?"},
        
        # ✅ Coding request
        {"question": "Write a Python function to check if a number is prime."},
        
        # ✅ Large text summarization
        {"question": "Summarize the following text: Artificial Intelligence is revolutionizing healthcare by enabling faster diagnostics, improving drug discovery, and personalizing treatment. However, it also raises ethical concerns such as bias, privacy, and accountability."},
        
        # ✅ Creative writing
        {"question": "Write a short sci-fi story about humans colonizing Mars in the year 2150."},
        
        # ✅ Multi-step math
        {"question": "Solve step by step: (25 * 4) + (300 / 5) - 42."},
        
        # ✅ Mixed language query
        {"question": "Translate 'How are you?' into French, Spanish, and Hindi."},
        
        # ✅ Edge case (very short)
        {"question": "Hi"},
        
        # ✅ Edge case (empty question)
        {"question": ""},
        
        # ✅ Edge case (long nonsense input)
        {"question": "asdfghjkl " * 50},
    ]

    for i, case in enumerate(cases, 1):
        print(f"\n🔹 Test Case {i}: {case['question'][:60]}...")
        response = requests.get(f"{BASE_URL}/ask", params=case)
        if response.status_code == 200:
            print("✅ Response:", response.json())
        else:
            print("❌ Error:", response.status_code, response.text)

if __name__ == "__main__":
    test_cases()
