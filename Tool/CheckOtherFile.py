import json
import os

def find_files_recursively(data_structure, files_set):
    """
    递归地遍历嵌套的列表和字典，以查找所有 "file" 键的值。

    Args:
        data_structure (any): 要遍历的JSON数据结构（可以是列表或字典）。
        files_set (set): 用于存储找到的文件名的集合。
    """
    # 如果当前数据是字典
    if isinstance(data_structure, dict):
        # 检查是否存在 "file" 键，并且其值是字符串
        if 'file' in data_structure and isinstance(data_structure['file'], str):
            files_set.add(data_structure['file'])
        
        # 递归遍历字典中的所有值
        for value in data_structure.values():
            find_files_recursively(value, files_set)
            
    # 如果当前数据是列表
    elif isinstance(data_structure, list):
        # 递归遍历列表中的所有项
        for item in data_structure:
            find_files_recursively(item, files_set)

def verify_files_from_json(json_filename="cave.json"):
    """
    检查JSON文件中引用的所有文件（包括嵌套的）与目录中的实际文件是否匹配。

    Args:
        json_filename (str): 要检查的JSON文件的名称。
    """
    try:
        script_filename = os.path.basename(__file__)
    except NameError:
        script_filename = "check_files_v2.py" # 确保在不同环境下都能工作

    # --- 步骤 1: 递归从JSON文件中提取所有引用的文件名 ---
    expected_files = set()
    try:
        with open(json_filename, 'r', encoding='utf-8') as f:
            data = json.load(f)
            # 使用递归函数来查找所有文件
            find_files_recursively(data, expected_files)
    except FileNotFoundError:
        print(f"错误: 在当前目录下未找到 '{json_filename}' 文件。")
        return
    except json.JSONDecodeError:
        print(f"错误: 无法解析 '{json_filename}' 的JSON格式，请检查文件内容。")
        return
    except Exception as e:
        print(f"读取JSON文件时发生未知错误: {e}")
        return

    print(f"📄 JSON文件 '{json_filename}' 中共引用了 {len(expected_files)} 个独立文件。")

    # --- 步骤 2: 获取目录中的所有实际文件名 ---
    try:
        actual_files = {f for f in os.listdir('.') if os.path.isfile(f)}
    except OSError as e:
        print(f"读取目录时发生错误: {e}")
        return

    # --- 步骤 3: 对比文件列表 ---
    missing_files = expected_files - actual_files
    ignored_files = {json_filename, script_filename}
    extra_files = actual_files - expected_files - ignored_files

    print("\n--- 文件校验结果 ---\n")

    # --- 步骤 4: 报告结果 ---
    if not missing_files and not extra_files:
        print("✅ 非常完美！所有文件都完全匹配，没有缺失或多余的文件。")
    else:
        if missing_files:
            print(f"❌ 发现 {len(missing_files)} 个缺失文件 (在JSON中定义，但文件夹中不存在):")
            for filename in sorted(list(missing_files)):
                print(f"  - {filename}")
        else:
            print("✅ 文件完整性良好，JSON中提到的所有文件都存在。")

        print("-" * 20)

        if extra_files:
            print(f"⚠️ 发现 {len(extra_files)} 个多余文件 (存在于文件夹中，但未在JSON中引用):")
            for filename in sorted(list(extra_files)):
                print(f"  - {filename}")
        else:
            print("✅ 目录整洁，没有发现JSON以外的多余文件。")

    print("\n--- 报告结束 ---")

if __name__ == "__main__":
    verify_files_from_json()